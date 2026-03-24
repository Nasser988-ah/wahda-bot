/* ============================================
   ZAKI LANDING PAGE — MAIN.JS
   Particles, scroll observer, nav, interactions
   ============================================ */

(function () {
  'use strict';

  /* -----------------------------------------
     PAGE LOADER
     ----------------------------------------- */
  window.addEventListener('load', function () {
    var loader = document.getElementById('pageLoader');
    if (loader) {
      loader.classList.add('loaded');
      setTimeout(function () { loader.style.display = 'none'; }, 700);
    }
    // Trigger hero animations on load
    revealHeroElements();
  });

  /* -----------------------------------------
     PARTICLE CANVAS
     80 tiny gold dots floating slowly
     ----------------------------------------- */
  var canvas = document.getElementById('particleCanvas');
  var ctx = canvas ? canvas.getContext('2d') : null;
  var particles = [];
  var PARTICLE_COUNT = 80;
  var animFrame;

  function initParticles() {
    if (!canvas || !ctx) return;
    resize();
    particles = [];
    for (var i = 0; i < PARTICLE_COUNT; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        r: Math.random() * 1.5 + 0.5,
        dx: (Math.random() - 0.5) * 0.3,
        dy: (Math.random() - 0.5) * 0.3,
        alpha: Math.random() * 0.5 + 0.2
      });
    }
    animate();
  }

  function resize() {
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  function animate() {
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      p.x += p.dx;
      p.y += p.dy;

      // Wrap around edges
      if (p.x < 0) p.x = canvas.width;
      if (p.x > canvas.width) p.x = 0;
      if (p.y < 0) p.y = canvas.height;
      if (p.y > canvas.height) p.y = 0;

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(245, 200, 66, ' + p.alpha + ')';
      ctx.fill();
    }

    animFrame = requestAnimationFrame(animate);
  }

  window.addEventListener('resize', function () {
    resize();
  });

  // Check prefers-reduced-motion
  var motionOk = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (motionOk) {
    initParticles();
  }

  /* -----------------------------------------
     STICKY NAV
     ----------------------------------------- */
  var nav = document.getElementById('mainNav');
  var scrollThreshold = 60;

  function handleNavScroll() {
    if (!nav) return;
    if (window.scrollY > scrollThreshold) {
      nav.classList.add('scrolled');
    } else {
      nav.classList.remove('scrolled');
    }
  }

  window.addEventListener('scroll', handleNavScroll, { passive: true });

  /* -----------------------------------------
     MOBILE NAV TOGGLE
     ----------------------------------------- */
  var navToggle = document.getElementById('navToggle');
  var navLinks = document.getElementById('navLinks');

  if (navToggle && navLinks) {
    navToggle.addEventListener('click', function () {
      navLinks.classList.toggle('open');
    });

    // Close on link click
    var links = navLinks.querySelectorAll('a');
    for (var i = 0; i < links.length; i++) {
      links[i].addEventListener('click', function () {
        navLinks.classList.remove('open');
      });
    }
  }

  /* -----------------------------------------
     SCROLL REVEAL — Intersection Observer
     ----------------------------------------- */
  function revealHeroElements() {
    var heroEls = document.querySelectorAll('.hero .anim-fade-up, .hero .anim-fade-down');
    heroEls.forEach(function (el) {
      var delay = parseFloat(el.getAttribute('data-delay') || 0) * 1000;
      setTimeout(function () {
        el.classList.add('in-view');
      }, delay);
    });
  }

  function initScrollReveal() {
    var elements = document.querySelectorAll(
      '.anim-slide-up, .anim-reveal, .anim-float-badge'
    );

    if (!('IntersectionObserver' in window)) {
      // Fallback: show everything
      elements.forEach(function (el) { el.classList.add('in-view'); });
      return;
    }

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          var el = entry.target;
          var delay = parseFloat(el.getAttribute('data-delay') || 0) * 1000;
          setTimeout(function () {
            el.classList.add('in-view');
          }, delay);
          observer.unobserve(el);
        }
      });
    }, {
      threshold: 0.15,
      rootMargin: '0px 0px -40px 0px'
    });

    elements.forEach(function (el) {
      observer.observe(el);
    });
  }

  initScrollReveal();

  /* -----------------------------------------
     STEPS LINE ANIMATION
     Draws connecting line on scroll
     ----------------------------------------- */
  function initStepsLine() {
    var lineFill = document.getElementById('stepsLineFill');
    var section = document.getElementById('how');
    if (!lineFill || !section) return;

    function updateLine() {
      var rect = section.getBoundingClientRect();
      var sectionHeight = section.offsetHeight;
      var viewH = window.innerHeight;

      // Calculate progress through section
      var start = rect.top - viewH * 0.7;
      var end = rect.bottom - viewH * 0.3;
      var total = end - start;
      var progress = Math.min(1, Math.max(0, -start / total));

      lineFill.style.height = (progress * 100) + '%';
    }

    window.addEventListener('scroll', updateLine, { passive: true });
    updateLine();
  }

  initStepsLine();

  /* -----------------------------------------
     SMOOTH SCROLL for anchor links
     ----------------------------------------- */
  document.querySelectorAll('a[href^="#"]').forEach(function (link) {
    link.addEventListener('click', function (e) {
      var target = document.querySelector(this.getAttribute('href'));
      if (target) {
        e.preventDefault();
        var offset = 80; // nav height
        var top = target.getBoundingClientRect().top + window.pageYOffset - offset;
        window.scrollTo({ top: top, behavior: 'smooth' });
      }
    });
  });

})();
