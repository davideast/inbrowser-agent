import stringDecoder from 'internal/nodelib/string_decoder';
import { preserveFunctionNames } from '../node-internal/util';

preserveFunctionNames([[stringDecoder.StringDecoder, 'StringDecoder']]);

export function createStringDecoderBuiltin() {
  return stringDecoder;
}
