import { expect, test } from '@playwright/test';
import { startHarnessServer } from './fixtures/harness-server.js';

test.describe('silent in-frame compositor and host viewport capture', () => {
  test('captures cross-origin iframe viewport screenshots in webp and png with rendered layout, borders, and text without permission prompts', async ({
    page,
  }) => {
    const harness = await startHarnessServer({
      frameTitle: 'Silent Capture Stage',
      frameBodyHtml: [
        '<style>',
        '  html, body { margin: 0; padding: 0; background: rgb(15, 23, 42); font: 700 28px/32px sans-serif; }',
        '  #card {',
        '    position: absolute; left: 40px; top: 30px; width: 220px; height: 110px;',
        '    box-sizing: border-box; background: rgb(239, 68, 68); border: 6px solid rgb(34, 197, 94);',
        '    border-radius: 12px; color: rgb(255, 255, 255); padding: 18px;',
        '  }',
        '</style>',
        '<main aria-label="stage">',
        '  <div id="card">LIVE</div>',
        '</main>',
      ].join('\n'),
    });

    try {
      await page.goto(`${harness.hostOrigin}/host`);

      const outcome = await page.evaluate(async (frameOrigin) => {
        const { connectIframe } = await import('@inbrowser/driver');
        const workspace = document.getElementById('workspace');
        if (!workspace) {
          throw new Error('Missing #workspace');
        }

        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'width: 360px; height: 220px; border: 0; display: block;';
        iframe.src = `${frameOrigin}/frame`;
        workspace.appendChild(iframe);

        const driver = await connectIframe(iframe);

        async function sampleImagePixels(bytes: Uint8Array, mimeType: string) {
          const bmp = await createImageBitmap(
            new Blob([new Uint8Array(bytes)], { type: mimeType }),
          );
          try {
            const c = document.createElement('canvas');
            c.width = bmp.width;
            c.height = bmp.height;
            const ctx = c.getContext('2d', { willReadFrequently: true });
            if (!ctx) {
              throw new Error('Missing 2d context');
            }
            ctx.drawImage(bmp, 0, 0);
            const at = (x: number, y: number): [number, number, number, number] => {
              const d = ctx.getImageData(x, y, 1, 1).data;
              return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, d[3] ?? 0];
            };
            const textRegion = ctx.getImageData(46, 36, 130, 54).data;
            let whiteTextPixelCount = 0;
            for (let i = 0; i < textRegion.length; i += 4) {
              if (
                (textRegion[i] ?? 0) > 220 &&
                (textRegion[i + 1] ?? 0) > 220 &&
                (textRegion[i + 2] ?? 0) > 220
              ) {
                whiteTextPixelCount += 1;
              }
            }
            return {
              decodedWidth: bmp.width,
              decodedHeight: bmp.height,
              backdropPixel: at(10, 10),
              borderPixel: at(150, 32),
              cardFillPixel: at(220, 110),
              whiteTextPixelCount,
            };
          } finally {
            bmp.close();
          }
        }

        try {
          const webpShot = await driver.capture({ mode: 'screenshot' });
          const pngShot = await driver.capture({ mode: 'screenshot', format: 'png' });
          const webpSample = await sampleImagePixels(webpShot.bytes, webpShot.mimeType);
          const pngSample = await sampleImagePixels(pngShot.bytes, pngShot.mimeType);

          return {
            hostOrigin: window.origin,
            frameOrigin,
            webpMeta: {
              mimeType: webpShot.mimeType,
              byteLength: webpShot.bytes.byteLength,
              width: webpShot.width,
              height: webpShot.height,
              modeUsed: webpShot.modeUsed,
              magicRiff: Array.from(webpShot.bytes.slice(0, 4)),
            },
            pngMeta: {
              mimeType: pngShot.mimeType,
              byteLength: pngShot.bytes.byteLength,
              width: pngShot.width,
              height: pngShot.height,
              modeUsed: pngShot.modeUsed,
              magicPng: Array.from(pngShot.bytes.slice(0, 4)),
            },
            webpSample,
            pngSample,
          };
        } finally {
          driver.dispose();
        }
      }, harness.frameOrigin);

      expect(outcome.hostOrigin).not.toBe(outcome.frameOrigin);
      expect(outcome.webpMeta).toMatchObject({
        mimeType: 'image/webp',
        width: 360,
        height: 220,
        modeUsed: 'silent',
        magicRiff: [0x52, 0x49, 0x46, 0x46],
      });
      expect(outcome.webpMeta.byteLength).toBeGreaterThan(64);

      expect(outcome.pngMeta).toMatchObject({
        mimeType: 'image/png',
        width: 360,
        height: 220,
        modeUsed: 'silent',
        magicPng: [0x89, 0x50, 0x4e, 0x47],
      });
      expect(outcome.pngSample.decodedWidth).toBe(360);
      expect(outcome.pngSample.decodedHeight).toBe(220);

      // Backdrop rgb(15, 23, 42)
      expect(outcome.pngSample.backdropPixel[0]).toBeLessThan(35);
      expect(outcome.pngSample.backdropPixel[2]).toBeGreaterThan(30);

      // Green border rgb(34, 197, 94)
      expect(outcome.pngSample.borderPixel[1]).toBeGreaterThan(160);
      expect(outcome.pngSample.borderPixel[0]).toBeLessThan(80);

      // Red card fill rgb(239, 68, 68)
      expect(outcome.pngSample.cardFillPixel[0]).toBeGreaterThan(200);
      expect(outcome.pngSample.cardFillPixel[1]).toBeLessThan(100);

      // White text glyphs rendered inside card
      expect(outcome.pngSample.whiteTextPixelCount).toBeGreaterThan(20);
      expect(outcome.webpSample.whiteTextPixelCount).toBeGreaterThan(15);
    } finally {
      await harness.close();
    }
  });

  test('crops element-targeted screenshots, renders open Shadow DOM and form control values, skips hidden subtrees, and propagates target errors', async ({
    page,
  }) => {
    const harness = await startHarnessServer({
      frameTitle: 'Targeted & Shadow Capture',
      frameBodyHtml: [
        '<style>',
        '  html, body { margin: 0; padding: 0; background: rgb(15, 23, 42); font: 600 18px/22px sans-serif; }',
        '  #export-btn {',
        '    position: absolute; left: 20px; top: 15px; width: 140px; height: 48px;',
        '    box-sizing: border-box; border: 0; background: rgb(37, 99, 235); color: rgb(255, 255, 255);',
        '    font: 700 18px/22px sans-serif;',
        '  }',
        '  #shadow-host { position: absolute; left: 20px; top: 80px; width: 320px; height: 130px; }',
        '  .secret {',
        '    position: absolute; left: 200px; top: 15px; width: 120px; height: 48px;',
        '    background: rgb(255, 0, 255); color: rgb(255, 0, 255);',
        '  }',
        '</style>',
        '<main aria-label="inspector">',
        '  <button id="export-btn" type="button">Export</button>',
        '  <button type="button">Duplicate</button>',
        '  <button type="button">Duplicate</button>',
        '  <div class="secret" hidden>H1</div>',
        '  <div class="secret" style="display: none">H2</div>',
        '  <div class="secret" style="visibility: hidden">H3</div>',
        '  <div class="secret" style="opacity: 0">H4</div>',
        '  <div id="shadow-host"></div>',
        '</main>',
        '<script>',
        '  const host = document.getElementById("shadow-host");',
        '  const sr = host.attachShadow({ mode: "open" });',
        '  sr.innerHTML = `',
        '    <style>',
        '      .panel { width: 320px; height: 130px; background: rgb(30, 41, 59); box-sizing: border-box; padding: 8px; }',
        '      input, textarea, select {',
        '        display: block; width: 280px; height: 32px; margin: 0 0 6px 0; padding: 0; border: 0;',
        '        background: rgb(15, 23, 42); color: rgb(255, 255, 255); font: 700 16px/20px sans-serif;',
        '      }',
        '    </style>',
        '    <section class="panel" aria-label="Shadow Form">',
        '      <input aria-label="Title" value="ALPHA" />',
        '      <textarea aria-label="Notes">BETA</textarea>',
        '      <select aria-label="Tier"><option value="GAMMA" selected>GAMMA</option></select>',
        '    </section>',
        '  `;',
        '</script>',
      ].join('\n'),
    });

    try {
      await page.goto(`${harness.hostOrigin}/host`);

      const summary = await page.evaluate(async (frameOrigin) => {
        const { connectIframe, DriverError } = await import('@inbrowser/driver');
        const workspace = document.getElementById('workspace');
        if (!workspace) {
          throw new Error('Missing #workspace');
        }

        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'width: 360px; height: 230px; border: 0; display: block;';
        iframe.src = `${frameOrigin}/frame`;
        workspace.appendChild(iframe);

        const driver = await connectIframe(iframe);

        async function decodeRgba(bytes: Uint8Array, mimeType: string) {
          const bmp = await createImageBitmap(
            new Blob([new Uint8Array(bytes)], { type: mimeType }),
          );
          try {
            const c = document.createElement('canvas');
            c.width = bmp.width;
            c.height = bmp.height;
            const ctx = c.getContext('2d', { willReadFrequently: true });
            if (!ctx) {
              throw new Error('Missing 2d');
            }
            ctx.drawImage(bmp, 0, 0);
            return {
              width: bmp.width,
              height: bmp.height,
              at(x: number, y: number): [number, number, number, number] {
                const d = ctx.getImageData(x, y, 1, 1).data;
                return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, d[3] ?? 0];
              },
              brightPixelsIn(x: number, y: number, w: number, h: number): number {
                const d = ctx.getImageData(x, y, w, h).data;
                let count = 0;
                for (let i = 0; i < d.length; i += 4) {
                  if ((d[i] ?? 0) > 200 && (d[i + 1] ?? 0) > 200 && (d[i + 2] ?? 0) > 200) {
                    count += 1;
                  }
                }
                return count;
              },
            };
          } finally {
            bmp.close();
          }
        }

        try {
          const snap = await driver.observe();
          let exportRef: (typeof snap.elements)[number]['ref'];
          const visit = (nodes: typeof snap.elements): void => {
            for (const n of nodes) {
              if (n.role === 'button' && n.name === 'Export' && n.ref) {
                exportRef = n.ref;
              }
              if (n.children) {
                visit(n.children);
              }
            }
          };
          visit(snap.elements);
          if (!exportRef) {
            throw new Error('Missing Export button ref');
          }

          const byRef = await driver.capture({
            mode: 'screenshot',
            target: exportRef,
            format: 'png',
          });
          const byRole = await driver.capture({
            mode: 'screenshot',
            target: { role: 'button', name: 'Export' },
            format: 'png',
          });
          const byText = await driver.capture({
            mode: 'screenshot',
            target: { text: 'Export' },
            format: 'png',
          });

          const btnImg = await decodeRgba(byRef.bytes, byRef.mimeType);
          const shadowShot = await driver.capture({
            mode: 'screenshot',
            target: { role: 'region', name: 'Shadow Form' },
            format: 'png',
          });
          const shadowImg = await decodeRgba(shadowShot.bytes, shadowShot.mimeType);

          const fullShot = await driver.capture({ mode: 'screenshot', format: 'png' });
          const fullImg = await decodeRgba(fullShot.bytes, fullShot.mimeType);

          let notFoundCode = 'NONE';
          try {
            await driver.capture({
              mode: 'screenshot',
              target: { role: 'button', name: 'DoesNotExist' },
            });
          } catch (err) {
            if (err instanceof DriverError) {
              notFoundCode = err.code;
            }
          }

          let ambiguousCode = 'NONE';
          let candidateCount = 0;
          try {
            await driver.capture({
              mode: 'screenshot',
              target: { role: 'button', name: 'Duplicate' },
            });
          } catch (err) {
            if (err instanceof DriverError) {
              ambiguousCode = err.code;
              candidateCount = err.candidates?.length ?? 0;
            }
          }

          return {
            byRefSize: [byRef.width, byRef.height],
            byRoleSize: [byRole.width, byRole.height],
            byTextSize: [byText.width, byText.height],
            btnCornerFill: btnImg.at(130, 40),
            btnBrightGlyphs: btnImg.brightPixelsIn(4, 4, 120, 36),
            shadowSize: [shadowShot.width, shadowShot.height],
            inputGlyphs: shadowImg.brightPixelsIn(8, 8, 160, 32),
            textareaGlyphs: shadowImg.brightPixelsIn(8, 46, 160, 32),
            selectGlyphs: shadowImg.brightPixelsIn(8, 84, 160, 32),
            hiddenRegionPixel: fullImg.at(240, 35),
            notFoundCode,
            ambiguousCode,
            candidateCount,
          };
        } finally {
          driver.dispose();
        }
      }, harness.frameOrigin);

      expect(summary.byRefSize).toEqual([140, 48]);
      expect(summary.byRoleSize).toEqual([140, 48]);
      expect(summary.byTextSize).toEqual([140, 48]);
      // Blue button background rgb(37, 99, 235)
      expect(summary.btnCornerFill[2]).toBeGreaterThan(200);
      expect(summary.btnCornerFill[0]).toBeLessThan(80);
      expect(summary.btnBrightGlyphs).toBeGreaterThan(15);

      // Open Shadow DOM panel + <input>, <textarea>, <select> value glyphs
      expect(summary.shadowSize).toEqual([320, 130]);
      expect(summary.inputGlyphs).toBeGreaterThan(10);
      expect(summary.textareaGlyphs).toBeGreaterThan(10);
      expect(summary.selectGlyphs).toBeGreaterThan(10);

      // Hidden magenta elements must not bleed onto dark backdrop rgb(15, 23, 42)
      expect(summary.hiddenRegionPixel[0]).toBeLessThan(40);
      expect(summary.hiddenRegionPixel[2]).toBeLessThan(70);

      expect(summary.notFoundCode).toBe('DRIVER_TARGET_NOT_FOUND');
      expect(summary.ambiguousCode).toBe('DRIVER_TARGET_AMBIGUOUS');
      expect(summary.candidateCount).toBe(2);
    } finally {
      await harness.close();
    }
  });

  test('composites live canvas, playing video frames, decoded images, and xmlns-free inline svg while excluding driver UI overlays', async ({
    page,
  }) => {
    const blueSvgDataUrl =
      'data:image/svg+xml;charset=utf-8,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="70" height="60"><rect width="70" height="60" fill="rgb(59, 130, 246)"/></svg>',
      );

    const harness = await startHarnessServer({
      frameTitle: 'Media & SVG Compositor',
      frameBodyHtml: [
        '<style>',
        '  html, body { margin: 0; padding: 0; background: rgb(15, 23, 42); }',
        '  #paint-canvas { position: absolute; left: 10px; top: 10px; width: 70px; height: 60px; }',
        '  #live-video   { position: absolute; left: 95px; top: 10px; width: 70px; height: 60px; }',
        '  #badge-img    { position: absolute; left: 180px; top: 10px; width: 70px; height: 60px; }',
        '  #inline-svg   { position: absolute; left: 265px; top: 10px; width: 70px; height: 60px; display: block; }',
        '  #trigger-btn  { position: absolute; left: 10px; top: 160px; width: 110px; height: 36px; background: rgb(30, 41, 59); color: #fff; border: 0; }',
        '  #driver-ghost { position: absolute; left: 10px; top: 90px; width: 160px; height: 55px; background: rgb(255, 0, 255); z-index: 99999; }',
        '</style>',
        '<main aria-label="media-stage">',
        '  <canvas id="paint-canvas" width="70" height="60"></canvas>',
        '  <video id="live-video" width="70" height="60" muted playsinline autoplay></video>',
        `  <img id="badge-img" width="70" height="60" alt="Blue tile" src="${blueSvgDataUrl}" />`,
        '  <svg id="inline-svg" viewBox="0 0 70 60" width="70" height="60">',
        '    <rect width="70" height="60" fill="rgb(234, 179, 8)"></rect>',
        '  </svg>',
        '  <div id="driver-ghost" data-inbrowser-driver-ui="test-overlay">OVERLAY</div>',
        '  <button id="trigger-btn" type="button">Ping</button>',
        '</main>',
        '<script>',
        '  const c = document.getElementById("paint-canvas");',
        '  const g = c.getContext("2d");',
        '  g.fillStyle = "rgb(239, 68, 68)";',
        '  g.fillRect(0, 0, 70, 60);',
        '',
        '  const src = document.createElement("canvas");',
        '  src.width = 70; src.height = 60;',
        '  const sg = src.getContext("2d");',
        '  const drawGreen = () => { sg.fillStyle = "rgb(34, 197, 94)"; sg.fillRect(0, 0, 70, 60); requestAnimationFrame(drawGreen); };',
        '  drawGreen();',
        '  const v = document.getElementById("live-video");',
        '  v.srcObject = src.captureStream(30);',
        '  window.__mediaReady = Promise.all([',
        '    v.play().then(() => new Promise((r) => {',
        '      const check = () => v.readyState >= 2 && v.videoWidth > 0 ? r(true) : setTimeout(check, 15);',
        '      check();',
        '    })),',
        '    document.getElementById("badge-img").decode(),',
        '  ]);',
        '</script>',
      ].join('\n'),
    });

    try {
      await page.goto(`${harness.hostOrigin}/host`);

      const pixels = await page.evaluate(async (frameOrigin) => {
        const { connectIframe } = await import('@inbrowser/driver');
        const workspace = document.getElementById('workspace');
        if (!workspace) {
          throw new Error('Missing #workspace');
        }

        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'width: 360px; height: 220px; border: 0; display: block;';
        iframe.src = `${frameOrigin}/frame`;
        workspace.appendChild(iframe);

        const driver = await connectIframe(iframe, { allowEval: true });
        try {
          await driver.eval({ expression: 'window.__mediaReady' });
          const snap = await driver.observe();
          let pingRef: (typeof snap.elements)[number]['ref'];
          const findBtn = (nodes: typeof snap.elements): void => {
            for (const n of nodes) {
              if (n.role === 'button' && n.name === 'Ping' && n.ref) {
                pingRef = n.ref;
              }
              if (n.children) {
                findBtn(n.children);
              }
            }
          };
          findBtn(snap.elements);
          if (!pingRef) {
            throw new Error('Missing Ping button ref');
          }

          // Mounts the preload [data-inbrowser-driver-ui="cursor"] overlay on #trigger-btn
          await driver.act({ rev: snap.rev, steps: [{ kind: 'click', target: pingRef }] });

          const shot = await driver.capture({ mode: 'screenshot', format: 'png' });
          const bmp = await createImageBitmap(
            new Blob([new Uint8Array(shot.bytes)], { type: shot.mimeType }),
          );
          try {
            const out = document.createElement('canvas');
            out.width = bmp.width;
            out.height = bmp.height;
            const ctx = out.getContext('2d', { willReadFrequently: true });
            if (!ctx) {
              throw new Error('Missing 2d');
            }
            ctx.drawImage(bmp, 0, 0);
            const at = (x: number, y: number): [number, number, number, number] => {
              const d = ctx.getImageData(x, y, 1, 1).data;
              return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, d[3] ?? 0];
            };
            return {
              canvasRed: at(45, 40),
              videoGreen: at(130, 40),
              imgBlue: at(215, 40),
              svgYellow: at(300, 40),
              driverUiGhostArea: at(60, 115),
              buttonCenterWithoutCursorDot: at(65, 178),
            };
          } finally {
            bmp.close();
          }
        } finally {
          driver.dispose();
        }
      }, harness.frameOrigin);

      // <canvas> rgb(239, 68, 68)
      expect(pixels.canvasRed[0]).toBeGreaterThan(200);
      expect(pixels.canvasRed[1]).toBeLessThan(100);

      // <video> rgb(34, 197, 94)
      expect(pixels.videoGreen[1]).toBeGreaterThan(150);
      expect(pixels.videoGreen[0]).toBeLessThan(90);

      // <img> rgb(59, 130, 246)
      expect(pixels.imgBlue[2]).toBeGreaterThan(200);
      expect(pixels.imgBlue[0]).toBeLessThan(100);

      // Inline <svg> without explicit xmlns rgb(234, 179, 8)
      expect(pixels.svgYellow[0]).toBeGreaterThan(200);
      expect(pixels.svgYellow[1]).toBeGreaterThan(150);
      expect(pixels.svgYellow[2]).toBeLessThan(60);

      // [data-inbrowser-driver-ui] magenta box excluded -> dark backdrop rgb(15, 23, 42)
      expect(pixels.driverUiGhostArea[0]).toBeLessThan(40);
      expect(pixels.driverUiGhostArea[2]).toBeLessThan(70);

      // Preload cursor overlay (#2563eb dot on button center) excluded -> button bg rgb(30, 41, 59) or white text, never bright blue #2563eb
      const [r, , b] = pixels.buttonCenterWithoutCursorDot;
      const isCursorBlue = r < 80 && b > 200;
      expect(isCursorBlue).toBe(false);
    } finally {
      await harness.close();
    }
  });

  test('records silent WebM video across start_recording and stop_recording on both connectIframe and connectPort with state-machine validation', async ({
    page,
  }) => {
    const harness = await startHarnessServer({
      frameTitle: 'Silent Recorder Stage',
      frameBodyHtml: [
        '<style>',
        '  html, body { margin: 0; padding: 0; background: rgb(15, 23, 42); }',
        '  #banner { width: 320px; height: 140px; background: rgb(220, 38, 38); color: #fff; font: 700 24px/40px sans-serif; }',
        '</style>',
        '<main aria-label="recorder">',
        '  <div id="banner">FRAME A</div>',
        "  <button type=\"button\" onclick=\"const b=document.getElementById('banner');b.style.background='rgb(22, 163, 74)';b.textContent='FRAME B';\">Flip</button>",
        '</main>',
      ].join('\n'),
    });

    try {
      await page.goto(`${harness.hostOrigin}/host`);

      const recordingSummary = await page.evaluate(async (frameOrigin) => {
        const { connectIframe, connectPort, DRIVER_CHANNEL, DriverError, PROTOCOL_VERSION } =
          await import('@inbrowser/driver');
        const workspace = document.getElementById('workspace');
        if (!workspace) {
          throw new Error('Missing #workspace');
        }

        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'width: 320px; height: 200px; border: 0; display: block;';
        iframe.src = `${frameOrigin}/frame`;
        workspace.appendChild(iframe);

        const driver = await connectIframe(iframe);
        let doubleStartCode = 'NONE';
        let inactiveStopCode = 'NONE';

        try {
          try {
            await driver.capture({ mode: 'stop_recording' });
          } catch (err) {
            if (err instanceof DriverError) {
              inactiveStopCode = err.code;
            }
          }

          const started = await driver.capture({ mode: 'start_recording' });
          try {
            await driver.capture({ mode: 'start_recording' });
          } catch (err) {
            if (err instanceof DriverError) {
              doubleStartCode = err.code;
            }
          }

          const snap = await driver.observe();
          await new Promise((r) => setTimeout(r, 110));
          await driver.act({
            rev: snap.rev,
            steps: [{ kind: 'click', target: { role: 'button', name: 'Flip' } }],
          });
          await new Promise((r) => setTimeout(r, 140));

          const stopped = await driver.capture({ mode: 'stop_recording' });
          driver.dispose();

          // Also verify silent recording over raw connectPort (no iframe element handle)
          const channel = new MessageChannel();
          if (!iframe.contentWindow) {
            throw new Error('Missing iframe contentWindow');
          }
          iframe.contentWindow.postMessage(
            {
              channel: DRIVER_CHANNEL,
              kind: 'bind_port',
              protocolVersion: PROTOCOL_VERSION,
            },
            frameOrigin,
            [channel.port2],
          );

          const portDriver = await connectPort(channel.port1);
          try {
            await portDriver.capture({ mode: 'start_recording' });
            await new Promise((r) => setTimeout(r, 180));
            const portStopped = await portDriver.capture({ mode: 'stop_recording' });

            return {
              inactiveStopCode,
              doubleStartCode,
              started: {
                mimeType: started.mimeType,
                byteLength: started.bytes.byteLength,
                modeUsed: started.modeUsed,
                durationMs: started.durationMs,
              },
              stopped: {
                mimeType: stopped.mimeType,
                byteLength: stopped.bytes.byteLength,
                ebmlHeader: Array.from(stopped.bytes.slice(0, 4)),
                width: stopped.width,
                height: stopped.height,
                modeUsed: stopped.modeUsed,
                durationMs: stopped.durationMs ?? -1,
              },
              portStopped: {
                mimeType: portStopped.mimeType,
                byteLength: portStopped.bytes.byteLength,
                ebmlHeader: Array.from(portStopped.bytes.slice(0, 4)),
                modeUsed: portStopped.modeUsed,
                durationMs: portStopped.durationMs ?? -1,
              },
            };
          } finally {
            portDriver.dispose();
          }
        } finally {
          driver.dispose();
        }
      }, harness.frameOrigin);

      expect(recordingSummary.inactiveStopCode).toBe('DRIVER_PROTOCOL');
      expect(recordingSummary.doubleStartCode).toBe('DRIVER_PROTOCOL');
      expect(recordingSummary.started).toEqual({
        mimeType: 'video/webm',
        byteLength: 0,
        modeUsed: 'silent',
        durationMs: 0,
      });
      expect(recordingSummary.stopped.mimeType).toBe('video/webm');
      expect(recordingSummary.stopped.ebmlHeader).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
      expect(recordingSummary.stopped.byteLength).toBeGreaterThan(100);
      expect(recordingSummary.stopped.width).toBe(320);
      expect(recordingSummary.stopped.height).toBe(200);
      expect(recordingSummary.stopped.modeUsed).toBe('silent');
      expect(recordingSummary.stopped.durationMs).toBeGreaterThanOrEqual(150);

      expect(recordingSummary.portStopped.mimeType).toBe('video/webm');
      expect(recordingSummary.portStopped.ebmlHeader).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
      expect(recordingSummary.portStopped.byteLength).toBeGreaterThan(100);
      expect(recordingSummary.portStopped.modeUsed).toBe('silent');
      expect(recordingSummary.portStopped.durationMs).toBeGreaterThanOrEqual(100);
    } finally {
      await harness.close();
    }
  });

  test('captures viewport-gpu screenshots and WebM recordings via DisplayMediaProvider, falls back cleanly on permission denial, and stops tracks on dispose', async ({
    page,
  }) => {
    const harness = await startHarnessServer({
      frameTitle: 'GPU Capture & Fallback Stage',
      frameBodyHtml: [
        '<style>',
        '  html, body { margin: 0; padding: 0; background: rgb(239, 68, 68); }',
        '  #chip { position: absolute; left: 20px; top: 20px; width: 100px; height: 40px; background: rgb(34, 197, 94); color: #fff; }',
        '</style>',
        '<main aria-label="gpu-stage"><div id="chip">CHIP</div></main>',
      ].join('\n'),
    });

    try {
      await page.goto(`${harness.hostOrigin}/host`);

      const gpuOutcome = await page.evaluate(async (frameOrigin) => {
        const { connectIframe } = await import('@inbrowser/driver');
        const workspace = document.getElementById('workspace');
        if (!workspace) {
          throw new Error('Missing #workspace');
        }

        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'width: 300px; height: 180px; border: 0; display: block;';
        iframe.src = `${frameOrigin}/frame`;
        workspace.appendChild(iframe);

        // Host GPU stream source painted solid cyan rgb(6, 182, 212) vs in-frame red rgb(239, 68, 68)
        const gpuCanvas = document.createElement('canvas');
        gpuCanvas.width = 300;
        gpuCanvas.height = 180;
        const gCtx = gpuCanvas.getContext('2d');
        if (!gCtx) {
          throw new Error('Missing 2d');
        }
        let pumping = true;
        const pump = (): void => {
          gCtx.fillStyle = 'rgb(6, 182, 212)';
          gCtx.fillRect(0, 0, 300, 180);
          if (pumping) {
            requestAnimationFrame(pump);
          }
        };
        pump();

        const hostStream = gpuCanvas.captureStream(30);
        const videoTrack = hostStream.getVideoTracks()[0];
        if (!videoTrack) {
          throw new Error('Missing video track');
        }

        let providerCalls = 0;
        const gpuDriver = await connectIframe(iframe, {
          displayMediaProvider: {
            async getDisplayMedia() {
              providerCalls += 1;
              return hostStream;
            },
          },
        });

        async function centerPixel(
          bytes: Uint8Array,
          mimeType: string,
        ): Promise<[number, number, number]> {
          const bmp = await createImageBitmap(
            new Blob([new Uint8Array(bytes)], { type: mimeType }),
          );
          try {
            const c = document.createElement('canvas');
            c.width = bmp.width;
            c.height = bmp.height;
            const ctx = c.getContext('2d', { willReadFrequently: true });
            if (!ctx) {
              throw new Error('Missing 2d');
            }
            ctx.drawImage(bmp, 0, 0);
            const d = ctx.getImageData(
              Math.floor(bmp.width / 2),
              Math.floor(bmp.height / 2),
              1,
              1,
            ).data;
            return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0];
          } finally {
            bmp.close();
          }
        }

        try {
          const capabilities = gpuDriver.capabilities;
          const gpuShot = await gpuDriver.capture({ mode: 'screenshot', format: 'png' });
          const gpuPixel = await centerPixel(gpuShot.bytes, gpuShot.mimeType);

          // Targeted capture delegates to silent in-frame compositor for exact element bounds
          const chipShot = await gpuDriver.capture({
            mode: 'screenshot',
            target: { text: 'CHIP' },
            format: 'png',
          });

          const recStart = await gpuDriver.capture({ mode: 'start_recording' });
          await new Promise((r) => setTimeout(r, 180));
          const recStop = await gpuDriver.capture({ mode: 'stop_recording' });
          const trackStateBeforeDispose = videoTrack.readyState;

          gpuDriver.dispose();
          const trackStateAfterDispose = videoTrack.readyState;

          // Verify graceful fallback to silent capture when DisplayMediaProvider denies permission
          const deniedDriver = await connectIframe(iframe, {
            displayMediaProvider: {
              async getDisplayMedia() {
                throw new DOMException('Permission denied', 'NotAllowedError');
              },
            },
          });
          try {
            const fallbackShot = await deniedDriver.capture({ mode: 'screenshot', format: 'png' });
            const fallbackPixel = await centerPixel(fallbackShot.bytes, fallbackShot.mimeType);
            await deniedDriver.capture({ mode: 'start_recording' });
            await new Promise((r) => setTimeout(r, 160));
            const fallbackRec = await deniedDriver.capture({ mode: 'stop_recording' });

            return {
              capabilities,
              providerCalls,
              gpuShot: {
                modeUsed: gpuShot.modeUsed,
                width: gpuShot.width,
                height: gpuShot.height,
                pixel: gpuPixel,
              },
              chipShot: {
                modeUsed: chipShot.modeUsed,
                width: chipShot.width,
                height: chipShot.height,
              },
              recStartMode: recStart.modeUsed,
              recStop: {
                modeUsed: recStop.modeUsed,
                mimeType: recStop.mimeType,
                ebmlHeader: Array.from(recStop.bytes.slice(0, 4)),
                byteLength: recStop.bytes.byteLength,
              },
              trackStateBeforeDispose,
              trackStateAfterDispose,
              fallbackShot: {
                modeUsed: fallbackShot.modeUsed,
                pixel: fallbackPixel,
              },
              fallbackRec: {
                modeUsed: fallbackRec.modeUsed,
                ebmlHeader: Array.from(fallbackRec.bytes.slice(0, 4)),
              },
            };
          } finally {
            deniedDriver.dispose();
          }
        } finally {
          pumping = false;
          gpuDriver.dispose();
        }
      }, harness.frameOrigin);

      expect(gpuOutcome.capabilities.captureModes).toEqual(['silent', 'viewport-gpu']);
      expect(gpuOutcome.providerCalls).toBe(1);

      // GPU screenshot came from cyan host stream rgb(6, 182, 212), not red guest DOM
      expect(gpuOutcome.gpuShot.modeUsed).toBe('viewport-gpu');
      expect(gpuOutcome.gpuShot.width).toBe(300);
      expect(gpuOutcome.gpuShot.height).toBe(180);
      expect(gpuOutcome.gpuShot.pixel[0]).toBeLessThan(50);
      expect(gpuOutcome.gpuShot.pixel[1]).toBeGreaterThan(150);
      expect(gpuOutcome.gpuShot.pixel[2]).toBeGreaterThan(180);

      expect(gpuOutcome.chipShot).toEqual({
        modeUsed: 'silent',
        width: 100,
        height: 40,
      });

      expect(gpuOutcome.recStartMode).toBe('viewport-gpu');
      expect(gpuOutcome.recStop.modeUsed).toBe('viewport-gpu');
      expect(gpuOutcome.recStop.mimeType).toBe('video/webm');
      expect(gpuOutcome.recStop.ebmlHeader).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
      expect(gpuOutcome.recStop.byteLength).toBeGreaterThan(100);
      expect(gpuOutcome.trackStateBeforeDispose).toBe('live');
      expect(gpuOutcome.trackStateAfterDispose).toBe('ended');

      // Fallback on NotAllowedError uses silent in-frame compositor (red guest backdrop rgb(239, 68, 68))
      expect(gpuOutcome.fallbackShot.modeUsed).toBe('silent');
      expect(gpuOutcome.fallbackShot.pixel[0]).toBeGreaterThan(200);
      expect(gpuOutcome.fallbackShot.pixel[2]).toBeLessThan(100);
      expect(gpuOutcome.fallbackRec.modeUsed).toBe('silent');
      expect(gpuOutcome.fallbackRec.ebmlHeader).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    } finally {
      await harness.close();
    }
  });

  test('renders aria-hidden visual chrome, inherits currentColor on inline svg, and draws scrolled clipped multi-line textarea and pre blocks', async ({
    page,
  }) => {
    const harness = await startHarnessServer({
      frameTitle: 'Visual Fidelity Stage',
      frameBodyHtml: [
        '<style>',
        '  html, body { margin: 0; padding: 0; background: rgb(17, 17, 20); font: 700 16px/24px monospace; }',
        '  #gutter {',
        '    position: absolute; left: 10px; top: 10px; width: 56px; height: 52px;',
        '    color: rgb(6, 182, 212); font: 700 22px/28px monospace;',
        '  }',
        '  #icon-wrap {',
        '    position: absolute; left: 80px; top: 10px; width: 48px; height: 48px;',
        '    color: rgb(34, 197, 94);',
        '  }',
        '  #hidden-probe {',
        '    position: absolute; left: 150px; top: 10px; width: 60px; height: 48px;',
        '    background: rgb(255, 0, 255); color: rgb(255, 0, 255);',
        '  }',
        '  #editor {',
        '    position: absolute; left: 10px; top: 80px; width: 150px; height: 80px;',
        '    box-sizing: border-box; margin: 0; padding: 4px 6px; border: 0;',
        '    background: rgb(30, 41, 59); color: rgb(255, 255, 255);',
        '    font: 700 16px/24px monospace; white-space: pre; overflow: auto;',
        '  }',
        '  #code-block {',
        '    position: absolute; left: 205px; top: 80px; width: 120px; height: 64px;',
        '    box-sizing: border-box; margin: 0; padding: 4px 6px; border: 0;',
        '    background: rgb(30, 41, 59); color: rgb(250, 204, 21);',
        '    font: 700 15px/22px monospace; white-space: pre; overflow: hidden;',
        '  }',
        '  #css-svg {',
        '    position: absolute; left: 240px; top: 10px; width: 48px; height: 48px;',
        '  }',
        '  #css-svg circle {',
        '    stroke: rgb(249, 115, 22); stroke-width: 6px; fill: none;',
        '  }',
        '  #soft-wrap {',
        '    position: absolute; left: 10px; top: 170px; width: 140px; height: 56px;',
        '    box-sizing: border-box; margin: 0; padding: 4px 6px; border: 0;',
        '    background: rgb(30, 41, 59); color: rgb(255, 255, 255);',
        '    font: 700 16px/22px monospace; white-space: pre-wrap; overflow: hidden;',
        '  }',
        '</style>',
        '<main aria-label="fidelity-stage">',
        '  <div id="gutter" aria-hidden="true">01</div>',
        '  <div id="icon-wrap">',
        '    <svg id="icon" viewBox="0 0 24 24" width="48" height="48" stroke="currentColor" fill="none" stroke-width="6">',
        '      <line x1="2" y1="12" x2="22" y2="12"></line>',
        '    </svg>',
        '  </div>',
        '  <svg id="css-svg" viewBox="0 0 24 24" width="48" height="48">',
        '    <circle cx="12" cy="12" r="7"></circle>',
        '  </svg>',
        '  <div id="hidden-probe" hidden>SECRET</div>',
        '  <textarea id="editor" aria-label="Editor"></textarea>',
        '  <textarea id="soft-wrap" aria-label="Wrapped Notes">ALPHA_WORD BETA_SECOND_LINE</textarea>',
        '  <pre id="code-block">PRE_ONE_OVERFLOW_WWWWWWWWWWWWWW\nPRE_TWO</pre>',
        '</main>',
        '<script>',
        '  const ed = document.getElementById("editor");',
        '  ed.value = [',
        '    "TOP_SCROLLED_OUT",',
        '    "LINE_A_OVERFLOW_ZZZZZZZZZZZZZZZZZZZZZZ",',
        '    "LINE_B_VISIBLE",',
        '    "LINE_C_VISIBLE",',
        '  ].join("\\n");',
        '  ed.scrollTop = 24;',
        '</script>',
      ].join('\n'),
    });

    try {
      await page.goto(`${harness.hostOrigin}/host`);

      const metrics = await page.evaluate(async (frameOrigin) => {
        const { connectIframe } = await import('@inbrowser/driver');
        const workspace = document.getElementById('workspace');
        if (!workspace) {
          throw new Error('Missing #workspace');
        }

        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'width: 360px; height: 240px; border: 0; display: block;';
        iframe.src = `${frameOrigin}/frame`;
        workspace.appendChild(iframe);

        const driver = await connectIframe(iframe);
        try {
          const shot = await driver.capture({ mode: 'screenshot', format: 'png' });
          const bmp = await createImageBitmap(
            new Blob([new Uint8Array(shot.bytes)], { type: shot.mimeType }),
          );
          try {
            const c = document.createElement('canvas');
            c.width = bmp.width;
            c.height = bmp.height;
            const ctx = c.getContext('2d', { willReadFrequently: true });
            if (!ctx) {
              throw new Error('Missing 2d');
            }
            ctx.drawImage(bmp, 0, 0);

            const countWhere = (
              x: number,
              y: number,
              w: number,
              h: number,
              pred: (r: number, g: number, b: number) => boolean,
            ): number => {
              const d = ctx.getImageData(x, y, w, h).data;
              let count = 0;
              for (let i = 0; i < d.length; i += 4) {
                if (pred(d[i] ?? 0, d[i + 1] ?? 0, d[i + 2] ?? 0)) {
                  count += 1;
                }
              }
              return count;
            };

            const isWhite = (r: number, g: number, b: number): boolean =>
              r > 200 && g > 200 && b > 200;
            const isCyan = (r: number, g: number, b: number): boolean =>
              r < 60 && g > 140 && b > 170;
            const isGreen = (r: number, g: number, b: number): boolean =>
              r < 90 && g > 150 && b < 130;
            const isYellow = (r: number, g: number, b: number): boolean =>
              r > 200 && g > 160 && b < 80;
            const isMagenta = (r: number, g: number, b: number): boolean =>
              r > 180 && g < 60 && b > 180;
            const isOrange = (r: number, g: number, b: number): boolean =>
              r > 200 && g > 80 && g < 160 && b < 70;

            return {
              gutterCyanPixels: countWhere(10, 10, 56, 52, isCyan),
              svgGreenPixels: countWhere(80, 10, 48, 48, isGreen),
              cssSvgOrangePixels: countWhere(240, 10, 48, 48, isOrange),
              hiddenMagentaPixels: countWhere(150, 10, 60, 48, isMagenta),
              textareaBand1White: countWhere(12, 82, 144, 24, isWhite),
              textareaBand2White: countWhere(12, 108, 144, 24, isWhite),
              textareaBand3White: countWhere(12, 132, 144, 24, isWhite),
              textareaRightGutterLeak: countWhere(162, 80, 40, 80, isWhite),
              softWrapLine2White: countWhere(12, 196, 132, 24, isWhite),
              preBand2Yellow: countWhere(207, 106, 114, 28, isYellow),
              preRightGutterLeak: countWhere(327, 80, 30, 64, isYellow),
            };
          } finally {
            bmp.close();
          }
        } finally {
          driver.dispose();
        }
      }, harness.frameOrigin);

      expect(metrics.gutterCyanPixels).toBeGreaterThan(12);
      expect(metrics.svgGreenPixels).toBeGreaterThan(25);
      expect(metrics.cssSvgOrangePixels).toBeGreaterThan(20);
      expect(metrics.hiddenMagentaPixels).toBe(0);
      expect(metrics.textareaBand1White).toBeGreaterThan(10);
      expect(metrics.textareaBand2White).toBeGreaterThan(10);
      expect(metrics.textareaBand3White).toBeGreaterThan(10);
      expect(metrics.textareaRightGutterLeak).toBe(0);
      expect(metrics.softWrapLine2White).toBeGreaterThan(10);
      expect(metrics.preBand2Yellow).toBeGreaterThan(8);
      expect(metrics.preRightGutterLeak).toBe(0);
    } finally {
      await harness.close();
    }
  });
});
