const $ = (id) => document.getElementById(id);
// ?tab=ID opens the popup for a specific tab (handy for debugging and screenshots)
const forced = Number(new URLSearchParams(location.search).get('tab'));
const tab = forced ? await chrome.tabs.get(forced) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
const fmt = (n) => n.toLocaleString('en-US');

async function render() {
  const s = await chrome.runtime.sendMessage({ type: 'popup:state', tabId: tab.id });
  if (!s) return;
  if (!s.web) {
    document.body.classList.add('inactive');
    $('status').textContent = 'Nothing to block here';
    $('host').textContent = 'Hush works on websites, not browser pages.';
    $('picker').disabled = true;
    $('totals').innerHTML = `<b>${fmt(s.total)}</b> blocked so far`;
    return;
  }
  document.body.classList.toggle('paused', s.disabled);
  $('toggle').checked = !s.disabled;
  $('status').textContent = s.disabled ? 'Paused on this site' : 'You’re protected';
  $('host').textContent = s.site;
  $('heroMark').setAttribute('d', s.disabled ? 'M9.5 9v6M14.5 9v6' : 'm8.5 12 2.5 2.5 4.5-5');
  $('toggleSub').textContent = s.disabled ? 'Ads and trackers are allowed here' : 'Turn off if a site misbehaves';
  $('ads').textContent = fmt(s.page.ads);
  $('trackers').textContent = fmt(s.page.trackers);
  $('threats').textContent = fmt(s.page.threats);
  $('picker').disabled = s.disabled;
  $('totals').innerHTML = `<b>${fmt(s.siteTotal)}</b> on this site · <b>${fmt(s.today)}</b> today · <b>${fmt(s.total)}</b> in total`;
}

$('toggle').addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  const s = await chrome.runtime.sendMessage({ type: 'popup:state', tabId: tab.id });
  await chrome.runtime.sendMessage({ type: 'site:set', site: s.site, enabled });
  // new rules only apply on the next load
  setTimeout(() => chrome.tabs.reload(tab.id), 150);
  await render();
});

$('picker').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'picker:start', tabId: tab.id });
  window.close();
});

render();
// counts keep arriving while the page loads
setInterval(render, 1500);
