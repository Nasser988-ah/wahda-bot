/* ============================================
   ZAKI LANDING PAGE — CHAT.JS
   WhatsApp chat mockup typing animation
   ============================================ */

(function () {
  'use strict';

  var container = document.getElementById('chatContainer');
  if (!container) return;

  /* Chat script — each entry is a message */
  var script = [
    { type: 'customer', text: 'قائمة', delay: 800 },
    { type: 'typing',  delay: 1000 },
    { type: 'bot',     text: 'أهلا! تفضل قائمة منتجاتنا', delay: 1200 },
    { type: 'customer', text: 'عايز رقم 1', delay: 900 },
    { type: 'typing',  delay: 800 },
    { type: 'bot',     text: 'تمت إضافة البرجر الكلاسيك\nالإجمالي: 85 جنيه', delay: 1200 },
    { type: 'customer', text: 'اطلب', delay: 800 },
    { type: 'typing',  delay: 900 },
    { type: 'bot',     text: 'تم استلام طلبك!\nرقم الطلب: #1234', delay: 0 }
  ];

  var chatStarted = false;
  var loopTimeout = null;

  /* Create a message bubble element */
  function createMessage(type, text) {
    var el = document.createElement('div');
    el.className = 'chat-msg chat-msg--' + type;
    if (text) {
      /* Support line breaks in messages */
      var escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      el.innerHTML = escaped.replace(/\n/g, '<br>');
    }
    return el;
  }

  /* Create typing indicator */
  function createTyping() {
    var el = document.createElement('div');
    el.className = 'chat-typing';
    for (var i = 0; i < 3; i++) {
      var dot = document.createElement('span');
      el.appendChild(dot);
    }
    return el;
  }

  /* Play the chat sequence */
  function playChat() {
    // Clear previous
    container.innerHTML = '';
    var index = 0;
    var typingEl = null;

    function next() {
      if (index >= script.length) {
        // Loop after 3s pause
        loopTimeout = setTimeout(playChat, 3000);
        return;
      }

      var entry = script[index];
      index++;

      if (entry.type === 'typing') {
        typingEl = createTyping();
        container.appendChild(typingEl);
        scrollChat();
        setTimeout(function () {
          if (typingEl && typingEl.parentNode) {
            typingEl.parentNode.removeChild(typingEl);
          }
          next();
        }, entry.delay);
        return;
      }

      var msg = createMessage(entry.type, entry.text);
      container.appendChild(msg);

      // Trigger reflow then show
      void msg.offsetWidth;
      msg.classList.add('visible');
      scrollChat();

      if (entry.delay > 0) {
        setTimeout(next, entry.delay);
      } else {
        // Last message, start loop timer
        loopTimeout = setTimeout(playChat, 3000);
      }
    }

    next();
  }

  function scrollChat() {
    container.scrollTop = container.scrollHeight;
  }

  /* Start chat when section enters viewport */
  function initChatObserver() {
    var section = document.getElementById('solution');
    if (!section) {
      // Fallback: start immediately
      playChat();
      return;
    }

    if (!('IntersectionObserver' in window)) {
      playChat();
      return;
    }

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting && !chatStarted) {
          chatStarted = true;
          playChat();
        }
      });
    }, { threshold: 0.3 });

    observer.observe(section);
  }

  initChatObserver();

})();
