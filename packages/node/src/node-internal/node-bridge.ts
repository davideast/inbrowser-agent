// Injected globals bridge for retained upstream Node.js v22.18.0 `lib/` modules.
// Retained/adapted under the Node.js MIT license (vendor/node-v22.18.0/LICENSE).

import './crypto/util';
import { internalBinding } from './internal-binding';
import { primordials } from './primordials';
import { guestProcess } from './process-ref';

export { primordials, internalBinding, guestProcess as process };
