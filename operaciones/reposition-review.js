// Shared between the signed-in workspace and invitation links.
window.RepoReview = (() => {
  function ask(title, message, fields, accept) {
    const dialog = document.createElement('dialog');
    dialog.className = 'repo-review-dialog';
    const form = document.createElement('form');
    const heading = document.createElement('h2');
    heading.textContent = title;
    const description = document.createElement('p');
    description.textContent = message;
    form.append(heading, description);
    for (const field of fields) {
      const label = document.createElement('label');
      label.textContent = field.label;
      const input = document.createElement('input');
      input.name = field.name;
      input.required = true;
      input.autocomplete = 'off';
      input.maxLength = 200;
      if (field.name === 'cantidad') {
        input.type = 'number';
        input.inputMode = 'numeric';
        input.min = '0';
        input.max = '999999';
        input.step = '1';
      }
      label.append(input);
      form.append(label);
    }
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancelar';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.textContent = accept;
    form.append(cancel,submit);
    dialog.append(form);
    document.body.append(dialog);
    return new Promise(resolve => {
      let result = null;
      form.onsubmit = event => {
        event.preventDefault();
        const values = Object.fromEntries(new FormData(form));
        if (fields.some(field => !values[field.name].trim())) return;
        result = values;
        dialog.close();
      };
      cancel.onclick = () => dialog.close();
      dialog.onclose = () => { dialog.remove(); resolve(result); };
      dialog.showModal();
    });
  }

  function panel(container, rows, actor, respond) {
    if (!container) return;
    const pending = rows.filter(row => row.review);
    const signature = JSON.stringify([actor,pending.map(row => [row.code,row.name,row.review])]);
    if (container.dataset.signature === signature) return;
    container.dataset.signature = signature;
    container.hidden = !pending.length;
    container.replaceChildren();
    if (!pending.length) return;
    const heading = document.createElement('h2');
    heading.textContent = 'Comprobaciones del equipo (' + pending.length + ')';
    container.append(heading);
    for (const row of pending) {
      const entry = document.createElement('article');
      const product = document.createElement('strong');
      product.textContent = row.name + ' · ' + row.code;
      const reason = document.createElement('p');
      reason.textContent = [row.review.nombre,row.review.motivo].filter(Boolean).join(' · ');
      entry.append(product,reason);
      if (actor && (row.review.automatica || actor !== row.review.actor)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Comprobar en el carro';
        button.onclick = () => respond(row);
        entry.append(button);
      }
      container.append(entry);
    }
  }

  async function act(row, session, access, rpc, refresh, notify) {
    const review = row.review;
    const values = review
      ? await ask('Comprobar en el carro',row.name + '. Contá todas las unidades de esta variante que ya están apartadas. Si ingresás cero, volverá a quedar pendiente.',
        [{name:'identidad',label:'Código del envase o SKU'},{name:'cantidad',label:'Total físico en el carro'}],'Confirmar recuento')
      : await ask('Pedir ayuda al equipo',row.name,[{name:'motivo',label:'¿Qué tiene que comprobar otra persona?'}],'Pedir comprobación');
    if (!values) return;
    try {
      await rpc({p_reposicion:session,p_codigo:row.code,p_revision:review?.id || null,
        p_cantidad:review ? Number(values.cantidad) : null,p_identidad:values.identidad || null,
        p_motivo:values.motivo || null,p_acceso:access});
      notify(review ? 'Recuento registrado' : 'Comprobación compartida con el equipo');
    } catch (error) { notify(error.message || 'No se pudo guardar la comprobación'); }
    await refresh();
  }
  async function identify(code,barcode,name,notify) {
    const values = await ask('Comprobar el envase',name,[{name:'identidad',label:'Leé las barras o ingresá el SKU del producto físico'}],'Continuar');
    if (!values) return false;
    const identity = values.identidad.trim();
    if (identity === String(code) || identity === barcode || window.SucaneitorBarcode?.matchesBarcode(barcode,identity)) return true;
    notify('El código ingresado no corresponde a este producto.','w');
    return false;
  }
  return {ask,panel,act,identify};
})();
