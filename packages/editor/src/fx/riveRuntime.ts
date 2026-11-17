// Loaded on demand. The wasm comes from the package itself (never a CDN): the editor works offline.
import * as rive from '@rive-app/canvas';
import wasmUrl from '@rive-app/canvas/rive.wasm?url';

rive.RuntimeLoader.setWasmUrl(wasmUrl);

export default rive;
