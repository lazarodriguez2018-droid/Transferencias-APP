const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const start = source.indexOf('function normalizeSessionSearch');
const end = source.indexOf('async function cargarSesionesDisponibles', start);
assert.ok(start >= 0 && end > start, 'No se encontraron las funciones del buscador de sesiones');

const elements = {
  'session-search': {value: ''},
  'session-location-filter': {value: '', innerHTML: ''},
  'session-results-count': {textContent: ''},
  'sesiones-items': {
    children: [],
    _innerHTML: '',
    set innerHTML(value) { this._innerHTML = value; this.children = []; },
    get innerHTML() { return this._innerHTML; },
    appendChild(value) { this.children.push(value); }
  }
};

const context = {
  assert,
  availableSessions: [],
  currentModule: 'inventario',
  window: {
    SucanCloud: {
      profile: {local_nombre: 'Punta del Este', almacen: 'PDE'},
      isSupervisor() { return true; }
    }
  },
  document: {
    getElementById(id) { return elements[id] || null; },
    createElement() {
      return {
        type: '', className: '', innerHTML: '', onclick: null, children: [], attributes: {},
        appendChild(value) { this.children.push(value); },
        setAttribute(name,value) { this.attributes[name] = value; }
      };
    }
  },
  esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
};

vm.createContext(context);
vm.runInContext(source.slice(start, end), context);

assert.equal(context.normalizeSessionSearch('Reposición MALDONADÓ'), 'reposicion maldonado');

context.availableSessions = [
  {id:'1', nombre:'Inventario PDE agosto', local_nombre:'Punta del Este', almacen:'PDE', productos:18, unidades:52, usuarios:[{nombre:'María Pérez'}], updated_at:'2026-08-22T12:00:00Z'},
  {id:'2', nombre:'Conteo mensual MDO', local_nombre:'Maldonado', almacen:'MDO', productos:9, unidades:21, usuarios:[{nombre:'Juan Silva'}], updated_at:'2026-08-22T13:00:00Z'}
];

context.populateSessionLocationFilter(context.availableSessions);
assert.match(elements['session-location-filter'].innerHTML, /Punta del Este/);
assert.match(elements['session-location-filter'].innerHTML, /Maldonado/);

elements['session-search'].value = 'pde maria';
context.renderAvailableSessions();
assert.equal(elements['sesiones-items'].children.length, 1, 'Debe combinar local y participante en una misma búsqueda');
assert.match(elements['sesiones-items'].children[0].children[0].innerHTML, /Inventario PDE agosto/);
assert.equal(elements['session-results-count'].textContent, '1 de 2 sesiones');

elements['session-search'].value = 'maldonado juan';
context.renderAvailableSessions();
assert.equal(elements['sesiones-items'].children.length, 1);
assert.match(elements['sesiones-items'].children[0].children[0].innerHTML, /Conteo mensual MDO/);

elements['session-search'].value = 'no existe';
context.renderAvailableSessions();
assert.equal(elements['sesiones-items'].children.length, 0);
assert.match(elements['sesiones-items'].innerHTML, /No hay resultados/);

context.currentModule = 'reposicion';
context.availableSessions = [{
  id:'r1',nombre:'PDE a MDO',origin:'Punta del Este',destination:'Maldonado',estado:'preparando',
  can_delete:true,summary:{productos:4,unidades_preparadas:1,unidades_pedidas:4},participantes:[]
}];
elements['session-search'].value = '';
context.renderAvailableSessions();
assert.equal(elements['sesiones-items'].children[0].children.length,2,
  'Una reposición eliminable debe mostrar su acción separada sin interferir con Entrar');
assert.match(elements['sesiones-items'].children[0].children[1].attributes['aria-label'],/Eliminar reposición/);

console.log('session-browser: OK');
