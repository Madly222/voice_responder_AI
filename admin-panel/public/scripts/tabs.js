// -------- tabs --------
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach(x=>x.classList.remove('active'));
  b.classList.add('active');
  
  ['health','faq','env','ultravox','asterisk','guide'].forEach(t => {
    document.querySelector('#tab-'+t).hidden = (t !== b.dataset.tab);
  });
  
  if (b.dataset.tab==='health') loadHealth();
  if (b.dataset.tab==='faq') loadFaq();
  if (b.dataset.tab==='env') loadEnv();
  if (b.dataset.tab==='ultravox') { loadUltravox(); loadUvTools(); }
  if (b.dataset.tab==='asterisk') loadAsterisk();
  if (b.dataset.tab==='guide') loadGuide();
});
