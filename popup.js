const checkbox = document.getElementById('reverseScroll');

chrome.storage.local.get('reverseScroll', (r) => {
  checkbox.checked = r.reverseScroll === true;
});

checkbox.addEventListener('change', () => {
  chrome.storage.local.set({ reverseScroll: checkbox.checked });
});
