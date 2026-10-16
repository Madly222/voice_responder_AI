// -------- ASTERISK --------
async function loadAsterisk() {
  const { files } = await api('/api/asterisk');

  $('#afile').innerHTML = files.map(f=>'<option>'+f+'</option>').join('');

  const load = async () => {
    const d = await api('/api/asterisk/'+$('#afile').value);
    $('#atext').value = d.content;
  };

  $('#afile').onchange = load;

  $('#saveA').onclick = async () => {
    try { await api('/api/asterisk/'+$('#afile').value,{method:'POST',
      headers:{'Content-Type':'application/json'}, body:JSON.stringify({content:$('#atext').value})});
      toast('Сохранено ('+$('#afile').value+'). Не забудь «Перечитать».'); }
    catch(e){ toast('Ошибка: '+e.message); }
  };

  $('#reloadA').onclick = async () => {
    try { await api('/api/restart/avr-asterisk',{method:'POST'}); toast('avr-asterisk перезапущен'); }
    catch(e){ toast('Ошибка: '+e.message); }
  };

  load();
}
