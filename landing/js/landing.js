(function () {
  const nav = document.querySelector('[data-site-nav]');
  const toggle = document.querySelector('[data-nav-toggle]');
  const yearEl = document.querySelector('[data-year]');

  document.querySelectorAll('img[data-shot-fallback]').forEach((img) => {
    const fallback = img.getAttribute('data-shot-fallback');
    if (!fallback) return;
    img.addEventListener('error', () => {
      if (img.dataset.fallbackApplied === '1') return;
      img.dataset.fallbackApplied = '1';
      img.src = fallback;
      img.removeAttribute('srcset');
      img.closest('picture')?.querySelectorAll('source').forEach((s) => s.remove());
    }, { once: true });
  });

  if (yearEl) {
    yearEl.textContent = String(new Date().getFullYear());
  }

  function setNavOpen(open) {
    if (!nav || !toggle) return;
    nav.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  toggle?.addEventListener('click', () => {
    setNavOpen(!nav.classList.contains('is-open'));
  });

  nav?.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => setNavOpen(false));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setNavOpen(false);
  });

  window.addEventListener('resize', () => {
    if (window.matchMedia('(min-width: 721px)').matches) {
      setNavOpen(false);
    }
  });
})();
