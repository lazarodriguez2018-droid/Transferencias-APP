const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const app=read('operaciones/app.js');
const repo=read('operaciones/reposition-app.js');
const receipt=read('operaciones/reception-app.js');
const html=read('operaciones/index.html');
const guestHtml=read('operaciones/invitado.html');
const guestJs=read('operaciones/invitado.js');

assert.match(app,/function operationsQrbox\(viewfinderWidth, viewfinderHeight\)/,'El recuadro debe calcularse con el visor real');
assert.match(app,/await scannerStoppingPromise/,'Inventario debe esperar el cierre anterior antes de reabrir la cámara');
assert.match(app,/activeHtml5Scanner\.clear\(\)/,'Inventario debe liberar completamente la instancia anterior');
assert.match(repo,/repoScannerOpening/,'Reposición debe bloquear aperturas dobles');
assert.match(repo,/repoScannerBusy = true/,'Reposición debe procesar una sola lectura a la vez');
assert.match(repo,/qrbox:operationsQrbox/,'Reposición debe recalcular el área de lectura');
assert.doesNotMatch(repo,/aspectRatio:1\.333/,'Reposición no debe forzar una relación que desplace el recuadro');
assert.match(receipt,/receiptScannerOpening/,'Recepción debe bloquear aperturas dobles');
assert.match(receipt,/receiptScannerBusy=true/,'Recepción debe procesar una sola lectura a la vez');
assert.match(receipt,/qrbox:operationsQrbox/,'Recepción debe recalcular el área de lectura');
assert.doesNotMatch(receipt,/aspectRatio:1\.333/,'Recepción no debe forzar una relación que desplace el recuadro');
assert.match(html,/\.repo-camera-modal\{[^}]*height:100dvh/,'La cámara autenticada debe conservar el alto visible del dispositivo');
assert.match(html,/\.repo-camera-reader\{[^}]*contain:layout paint/,'El visor no debe alterar el resto de la pantalla');
assert.match(guestHtml,/class="guest-scan-button"[^>]*onclick="openGuestScanner\(\)"/,'Todos los invitados deben ver el botón general de escaneo');
assert.match(guestJs,/openGuestRepoScanner/,'Reposición invitada debe conservar el escaneo contextual');

console.log('scanner-stability: OK');
