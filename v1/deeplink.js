/*
 * deeplink.js — 支持通过 ?box=A038 直接打开指定盒型
 * 供盒型静态页（box/<ID>/index.html）的「在设计器中打开」按钮使用。
 * 不依赖 app.js 改动：轮询等待盒型下拉框填充完成后自动选中并触发 change。
 */
(function () {
  var m = /[?&]box=([^&]+)/.exec(location.search);
  if (!m) return;
  var id = decodeURIComponent(m[1]).trim().toUpperCase();

  function select() {
    var sel = document.getElementById('boxTypeSelect');
    if (!sel || !sel.options || sel.options.length === 0) return false;
    for (var i = 0; i < sel.options.length; i++) {
      var text = (sel.options[i].textContent || '').toUpperCase();
      if (text === id || text.indexOf(id + ' -') === 0 || text.indexOf(id + ' ') === 0) {
        sel.value = sel.options[i].value;
        if (typeof Event === 'function') sel.dispatchEvent(new Event('change'));
        return true;
      }
    }
    return false;
  }

  var tries = 0;
  (function poll() {
    if (select()) return;
    if (++tries > 60) return;
    setTimeout(poll, 100);
  })();
})();
