// Person page behaviour. Kept in a file rather than inline so the page can run
// under a strict script-src 'self' CSP. Everything here is progressive: with JS
// off, the forms still submit and the share link is still selectable text.

for (const form of document.querySelectorAll('form[data-confirm]')) {
  form.addEventListener('submit', (event) => {
    if (!window.confirm(form.dataset.confirm)) event.preventDefault();
  });
}

const copyBtn = document.getElementById('copy-btn');

if (copyBtn) {
  copyBtn.addEventListener('click', async () => {
    const label = copyBtn.dataset.label || copyBtn.textContent;
    copyBtn.dataset.label = label;
    try {
      await navigator.clipboard.writeText(copyBtn.dataset.url);
      copyBtn.textContent = 'Copied';
      setTimeout(() => { copyBtn.textContent = label; }, 1400);
    } catch (err) {
      // No clipboard permission (or an insecure origin): select the URL so a
      // long-press copy is one gesture away instead of a dead button.
      const node = document.getElementById('share-url');
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      copyBtn.textContent = 'Copy the selection';
    }
  });
}
