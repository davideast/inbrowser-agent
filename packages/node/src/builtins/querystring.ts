import querystring from 'internal/nodelib/querystring';
import { preserveFunctionNames } from '../node-internal/util';

preserveFunctionNames([
  [querystring.unescapeBuffer, 'unescapeBuffer'],
  [querystring.unescape, 'qsUnescape'],
  [querystring.escape, 'qsEscape'],
  [querystring.stringify, 'stringify'],
  [querystring.parse, 'parse'],
]);

export function createQuerystringBuiltin() {
  return querystring;
}
