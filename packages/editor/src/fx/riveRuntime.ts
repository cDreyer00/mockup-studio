// Carregado sob demanda. O wasm sai do próprio pacote (nunca CDN): o editor funciona offline.
import * as rive from '@rive-app/canvas';
import wasmUrl from '@rive-app/canvas/rive.wasm?url';

rive.RuntimeLoader.setWasmUrl(wasmUrl);

export default rive;
