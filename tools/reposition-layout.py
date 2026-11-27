#!/usr/bin/env python3
"""Exercise both production picking cards at phone, landscape, tablet and desktop widths.
Serve synthetic content exclusively on the CI runner's loopback interface.
"""
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import html
import json
import re
import shutil
import subprocess
import tempfile
import threading

base = Path(__file__).resolve().parents[1] / 'operaciones'
def read(f):return (base/f).read_text()
name='GRAN PLUS GOURMET – GATO ADULTO CASTRADO SALMÓN Y POLLO · PRESENTACIÓN ESPECIAL 1 KG'
review=read('reposition-review.js')
reviewcss=read('reposition-review.css')
staffcss='\n'.join(re.findall(r'<style[^>]*>(.*?)</style>',read('index.html'),re.S))
def view(guest):
 if guest:
  markup='<main class="guest-shell"><section id="repo-team-review" class="repo-team-review"></section><section id="guest-module-content"></section></main>'
  js=read('invitado.js'); func=js[js.index('function repoPending'):js.index('function renderReceipt()')]
  script="""const $=id=>document.getElementById(id),num=Number,escHtml=String,js=String;
const app={selected:'',state:{session:{origin:'Punta del Este',destination:'Maldonado'},guest:{id:'b',client_id:'b'},items:[{code:'123',name:NAME,requested:3,prepared:1,assigned_client:'b'},other]}};
const centerGuestProduct=()=>{},guestTeamAction=()=>{},guestOrderLinks=()=>'';
const actionButton=(label,fn,cls)=>'<button class="'+cls+'">'+label+'</button>';
"""+func+'renderRepo();'
  css=read('invitado.css')
 else:
  markup=read('index.html').split('<!-- ===== REPOSICIÓN: PREPARAR ===== -->')[1].split('<!-- ===== REPOSICIÓN: LISTA')[0].replace('class="page repo-page"','class="page active repo-page"')
  js=read('reposition-app.js');func=js[js.index('function renderRepoCurrent()'):js.index('async function repoFound')]
  script="""const repoState={estado:'preparando',origin:'Punta del Este',destination:'Maldonado',items:[{codigo:'123',nombre:NAME,barras:'1234567890123',pedido:3,preparado:1,asignado_cliente:'b'},{codigo:other.code,nombre:other.name,review:other.review}]};
let repoCurrentIndex=0,repoExhausted=false;window.SucanCloud={user:{id:'b'}};
const repoCanEdit=()=>true,repoShouldAutoAssign=()=>true,repoItemOwnedByMe=x=>x.asignado_cliente==='b',repoEncoded=String,esc=String,repoOrderLinks=()=>'',repoTeamAction=()=>{},repoReviewItem=x=>({code:x.codigo,name:x.nombre,review:x.review}),SucaneitorReposition={status:()=> 'parcial'};"""+func+'renderRepoCurrent();'
  css=staffcss
 css=re.sub(r'@import[^;]+;','',css)
 return '<meta name="viewport" content="width=device-width"><style>'+css+'\n'+reviewcss+'</style>'+markup+'<script>'+review+"\nconst NAME="+repr(name)+";const other={code:'991',name:NAME,review:{id:'1',actor:'a',nombre:'Usuario de prueba',motivo:'Verificar producto físico'}};"+script+'</script>'
s='<title>Prueba de Reposición</title>'
for width,height in [(320,568),(390,844),(768,1024),(844,390),(1440,900)]:
 for guest in (True,False):
  s+=f'<iframe title="{width}-{guest}" width="{width}" height="{height}" srcdoc="{html.escape(view(guest),quote=True)}"></iframe>'
s+="""<pre id="report"></pre><script>window.onload=()=>{let out=[];for(const f of document.querySelectorAll('iframe')){const d=f.contentDocument,w=d.documentElement.clientWidth;const bad=[...d.querySelectorAll('button,h2,input')].filter(x=>x.offsetWidth>0&&(x.getBoundingClientRect().right>w+1||x.getBoundingClientRect().left< -1));out.push([f.title,w,d.documentElement.scrollWidth,d.body.innerText.includes('Encontrado') && d.body.innerText.includes('Comprobar en el carro'),bad.map(b=>b.textContent)]);}document.getElementById('report').textContent=JSON.stringify(out);};</script>"""

class Fixture(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.end_headers()
        self.wfile.write(s.encode())

def main():
    chrome = shutil.which('google-chrome') or shutil.which('chromium')
    if not chrome:
        raise RuntimeError('Chrome required for viewport regression tests')
    with ThreadingHTTPServer(('127.0.0.1', 0), Fixture) as server, tempfile.TemporaryDirectory() as profile:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        run = subprocess.run([chrome, '--headless', '--no-sandbox', '--disable-gpu',
            '--disable-background-networking', '--user-data-dir=' + profile, '--dump-dom',
            'http://127.0.0.1:' + str(server.server_port)], capture_output=True, text=True, timeout=60, check=True)
        server.shutdown()
    report = json.loads(html.unescape(re.search(r'<pre id="report">([^<]+)</pre>', run.stdout).group(1)))
    assert len(report) == 10, report
    for case, width, scroll_width, controls_visible, overflowing in report:
        print(case, width, scroll_width, controls_visible, overflowing)
        assert controls_visible and scroll_width <= width + 1 and not overflowing, case

if __name__ == '__main__':
    main()

