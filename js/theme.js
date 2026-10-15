// js/theme.js
// Tema luminoasa / intunecata, comuna tuturor paginilor. Se incarca SINCRON in
// <head>, inaintea CSS-ului randat, ca pagina sa nu clipeasca in tema gresita.
//
// Fara alegere salvata, urmam setarea sistemului (prefers-color-scheme), iar
// CSS-ul se descurca singur prin media query. Dupa un click pe buton, alegerea
// se salveaza si se aplica prin data-theme pe <html>, care are prioritate.
(function () {
  "use strict";
  var KEY = "pzuro.theme";
  var root = document.documentElement;
  var media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function saved() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }

  function current() {
    var t = root.getAttribute("data-theme");
    if (t === "dark" || t === "light") return t;
    return media && media.matches ? "dark" : "light";
  }

  var s = saved();
  if (s === "dark" || s === "light") root.setAttribute("data-theme", s);

  function syncButtons() {
    var dark = current() === "dark";
    var btns = document.querySelectorAll(".theme-toggle");
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute("aria-pressed", dark ? "true" : "false");
      btns[i].setAttribute("aria-label", dark ? "Treci la tema luminoasă" : "Treci la tema întunecată");
      btns[i].title = dark ? "Temă luminoasă" : "Temă întunecată";
    }
  }

  function notify() {
    syncButtons();
    // graficele (canvas) nu urmeaza CSS-ul singure -- app.js le redeseneaza
    document.dispatchEvent(new CustomEvent("pzuro-theme", { detail: current() }));
  }

  function toggle() {
    var next = current() === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem(KEY, next); } catch (e) { /* mod privat: doar pentru vizita curenta */ }
    notify();
  }

  window.PzuroTheme = { current: current };

  document.addEventListener("DOMContentLoaded", function () {
    var btns = document.querySelectorAll(".theme-toggle");
    for (var i = 0; i < btns.length; i++) btns[i].addEventListener("click", toggle);
    syncButtons();
  });
  if (media && media.addEventListener) {
    media.addEventListener("change", function () { if (!root.getAttribute("data-theme")) notify(); });
  }
})();
