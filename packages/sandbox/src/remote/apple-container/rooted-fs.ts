import type { SandboxDirent, SandboxSnapshot, SandboxStats } from '../../types.js';
import type { HostCommandRunner } from '../host/types.js';

/** Executed as root, separately from the unprivileged workload. All imports and
 * input parsing precede chroot; operations retain no host/container-root handles. */
export const ROOTED_FS_SCRIPT = String.raw`
import os, sys, json, stat, base64, time
p = json.load(sys.stdin)
root = p['root']
fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
for part in root.split('/'):
    if not part: continue
    if part in ('.', '..'): raise ValueError('Invalid root')
    nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
    os.close(fd)
    fd = nxt
os.fchdir(fd)
os.chroot('.')
os.chdir('/')
os.close(fd)
def relative(path):
    if path == root: return '.'
    if not path.startswith(root + '/'): raise ValueError('Path escapes sandbox root')
    parts = path[len(root)+1:].split('/')
    if any(x in ('', '.', '..') for x in parts): raise ValueError('Invalid path')
    return '/'.join(parts)
def parent(path, create=False):
    rel = relative(path)
    bits = rel.split('/')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    for bit in bits[:-1]:
        if create:
            try:
                os.mkdir(bit, dir_fd=fd)
                os.chown(bit,1000,1000,dir_fd=fd,follow_symlinks=False)
            except FileExistsError: pass
        nxt = os.open(bit, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        os.close(fd)
        fd = nxt
    return fd, bits[-1]
def info(fd, name):
    s = os.stat(name, dir_fd=fd, follow_symlinks=False)
    if stat.S_ISLNK(s.st_mode): raise ValueError('Symlinks are not supported by the rooted filesystem')
    if not (stat.S_ISREG(s.st_mode) or stat.S_ISDIR(s.st_mode)): raise ValueError('Special files are not supported')
    if stat.S_ISREG(s.st_mode) and s.st_nlink != 1: raise ValueError('Hard links are not supported')
    return s
def read(path):
    fd, name = parent(path)
    info(fd,name)
    f = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    os.close(fd)
    st = os.fstat(f)
    if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
        os.close(f)
        raise ValueError('Only unlinked regular workspace files are supported')
    with os.fdopen(f,'rb') as stream:
        data = stream.read(1048577)
    if len(data)>1048576: raise ValueError('File exceeds 1 MiB limit')
    return data
def write(path, data):
    fd,name=parent(path,True)
    try: info(fd,name)
    except FileNotFoundError: pass
    temporary='.bridge-write-'+os.urandom(16).hex()
    f=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o644,dir_fd=fd)
    try:
        with os.fdopen(f,'wb') as stream:
            stream.write(data)
            os.fchown(stream.fileno(),1000,1000)
        os.rename(temporary,name,src_dir_fd=fd,dst_dir_fd=fd)
    finally:
        try: os.unlink(temporary,dir_fd=fd)
        except FileNotFoundError: pass
        os.close(fd)

def mkdir(path, recursive):
    fd,name=parent(path,recursive)
    try: os.mkdir(name, dir_fd=fd)
    except FileExistsError:
        if not recursive: raise
        if not stat.S_ISDIR(info(fd,name).st_mode): raise ValueError('Not a directory')
    os.chown(name,1000,1000,dir_fd=fd,follow_symlinks=False)
    os.close(fd)
def remove_at(fd,name,recursive):
    s=os.stat(name,dir_fd=fd,follow_symlinks=False)
    if stat.S_ISDIR(s.st_mode):
        if recursive:
            child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            for entry in os.listdir(child): remove_at(child,entry,True)
            os.close(child)
        os.rmdir(name,dir_fd=fd)
    else: os.unlink(name,dir_fd=fd)
def listing(path):
    fd,name=parent(path)
    info(fd,name)
    child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
    os.close(fd)
    rows=[]
    for n in sorted(os.listdir(child)):
        s=info(child,n)
        rows.append({'name':n,'path':path.rstrip('/')+'/'+n,'type':'directory' if stat.S_ISDIR(s.st_mode) else 'file'})
    os.close(child)
    return rows
op=p['op']; path=p.get('path',root); result=None
if op=='read': result=base64.b64encode(read(path)).decode()
elif op=='write': write(path,base64.b64decode(p['data'],validate=True))
elif op=='mkdir': mkdir(path,p.get('recursive',False))
elif op=='list': result=listing(path)
elif op=='stat':
    fd,name=parent(path); s=info(fd,name); os.close(fd)
    result={'type':'directory' if stat.S_ISDIR(s.st_mode) else 'file','size':s.st_size,'mtimeMs':s.st_mtime*1000,'ctimeMs':s.st_ctime*1000}
elif op=='delete':
    if path==root: raise ValueError('Cannot delete root')
    fd,name=parent(path); remove_at(fd,name,p.get('recursive',False)); os.close(fd)
elif op=='rename':
    if path==root or p['to']==root: raise ValueError('Cannot rename root')
    a,an=parent(path); b,bn=parent(p['to']); info(a,an)
    try: info(b,bn)
    except FileNotFoundError: pass
    os.rename(an,bn,src_dir_fd=a,dst_dir_fd=b); os.close(a); os.close(b)
elif op=='snapshot':
    entries=[]
    def walk(path):
        for row in listing(path):
            if row['type']=='directory': walk(row['path'])
            else: entries.append({'path':row['path'],'type':'file','content':read(row['path']).decode('utf8',errors='replace')})
    walk(path)
    result={'root':path,'entries':entries,'createdAt':int(time.time()*1000)}
elif op=='restore':
    snap=p['snapshot']
    if snap['root']!=root: raise ValueError('Snapshot root mismatch')
    for entry in snap['entries']: relative(entry['path'])
    if p.get('clearRoot',False):
        fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
        for name in os.listdir(fd): remove_at(fd,name,True)
        os.close(fd)
    for entry in snap['entries']:
        if entry['type']=='directory': mkdir(entry['path'],True)
        else: write(entry['path'],entry.get('content','').encode())
else: raise ValueError('Unknown filesystem operation')
print(json.dumps(result))
`;

export function createRootedContainerFileSystem(
  runner: HostCommandRunner,
  bin: string,
  name: string,
  root: string,
) {
  async function call<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await runner.run(
      [bin, 'exec', '--interactive', '--user', '0', name, 'python3', '-I', '-c', ROOTED_FS_SCRIPT],
      {
        input: JSON.stringify({ op, root, ...args }),
        rejectOnFailure: true,
        maxBufferedOutputChars: 2_097_152,
      },
    );
    if (result.stdoutTruncated) throw new Error('Filesystem result exceeds limit');
    return JSON.parse(result.stdout) as T;
  }
  return {
    async readFile(path: string) {
      return new Uint8Array(Buffer.from(await call<string>('read', { path }), 'base64'));
    },
    async writeFile(path: string, data: Uint8Array) {
      await call('write', { path, data: Buffer.from(data).toString('base64') });
    },
    async mkdir(path: string, options?: { recursive?: boolean }) {
      await call('mkdir', { path, ...options });
    },
    async readdir(
      path: string,
      options?: { withFileTypes?: boolean },
    ): Promise<string[] | SandboxDirent[]> {
      const rows = await call<Array<{ name: string; path: string; type: 'file' | 'directory' }>>(
        'list',
        { path },
      );
      return options?.withFileTypes
        ? rows.map((row) => ({
            ...row,
            isFile: () => row.type === 'file',
            isDirectory: () => row.type === 'directory',
          }))
        : rows.map((row) => row.name);
    },
    async stat(path: string): Promise<SandboxStats> {
      const s = await call<Omit<SandboxStats, 'isFile' | 'isDirectory'>>('stat', { path });
      return { ...s, isFile: () => s.type === 'file', isDirectory: () => s.type === 'directory' };
    },
    async unlink(path: string) {
      await call('delete', { path });
    },
    async rmdir(path: string, options?: { recursive?: boolean }) {
      await call('delete', { path, ...options });
    },
    async rename(from: string, to: string) {
      await call('rename', { path: from, to });
    },
    snapshot: (path = root) => call<SandboxSnapshot>('snapshot', { path }),
    async restore(snapshot: SandboxSnapshot, options?: { clearRoot?: boolean }) {
      await call('restore', { snapshot, ...options });
    },
  };
}
