import crypto from 'node:crypto';
export function textInput(input){if(typeof input?.text!=='string')throw new Error('input_text_required');return input.text;}
// Character.isWhitespace || Character.isSpaceChar, matching the Android ABI.
const spaces=/[\u0009-\u000d\u001c-\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g;
export function normalize(text){return text.normalize('NFC').replace(spaces,' ').replace(/^ +| +$/g,'');}
export function builtin(operation,input){const text=textInput(input);if(operation==='sha256')return {sha256:crypto.createHash('sha256').update(text,'utf8').digest('hex')};if(operation==='text.normalize')return {text:normalize(text)};throw Error('unsupported_builtin');}
