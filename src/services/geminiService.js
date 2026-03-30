const Groq = require('groq-sdk');

class AIService {
  constructor() {
    this.groq = null;
    this.customGroq = new Map(); // Store custom Groq instances per shop
    this.initialized = false;
  }

  initialize() {
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey) {
      this.groq = new Groq({ apiKey: groqKey });
      this.initialized = true;
      console.log('✅ AI service initialized (Groq)');
      return true;
    }
    console.warn('⚠️ GROQ_API_KEY not set - AI service will not work');
    return false;
  }

  initializeCustom(shopId, apiKey) {
    if (apiKey) {
      this.customGroq.set(shopId, new Groq({ apiKey }));
      console.log(`✅ Custom AI service initialized for shop ${shopId}`);
      return true;
    }
    return false;
  }

  async getResponse(systemPrompt, customerMessage, context = {}, options = {}) {
    let groqClient = this.groq;
    
    // Use custom API key if shopId is provided
    if (context.shopId && this.customGroq.has(context.shopId)) {
      groqClient = this.customGroq.get(context.shopId);
    } else if (!this.initialized) {
      this.initialize();
    }
    
    if (!groqClient) {
      return 'عذراً، خدمة الذكاء الاصطناعي غير متاحة حالياً.';
    }

    const temperature = options.temperature ?? 0.7;
    const maxTokens = options.maxTokens ?? 300;

    // Build context string (exclude session history - it goes as chat messages)
    let contextStr = '';
    if (context.shopName) contextStr += `اسم المتجر/الشركة: ${context.shopName}\n`;
    if (context.currentMenu) contextStr += `القائمة الحالية: ${context.currentMenu}\n`;
    if (context.menuItems) contextStr += `عناصر القائمة المتاحة:\n${context.menuItems}\n`;
    if (context.itemContext) contextStr += `سياق العنصر: ${context.itemContext}\n`;

    const fullSystemPrompt = contextStr ? `${systemPrompt}\n\n${contextStr}` : systemPrompt;

    // Hard language constraint - always prepend Arabic-only rule
    const languageConstraint = 'تعليمات صارمة: يجب أن ترد دائماً باللغة العربية فقط. لا تستخدم أي لغة أخرى مطلقاً (لا يابانية، لا صينية، لا إنجليزية إلا إذا طلب العميل ذلك). CRITICAL: Always respond in Arabic only. Never switch to Japanese, Chinese, or any other language.\n\n';

    // Build multi-turn messages from session history
    const messages = [{ role: 'system', content: languageConstraint + fullSystemPrompt }];

    // Add conversation history as proper chat turns for better context
    if (context.sessionHistory) {
      const historyLines = context.sessionHistory.split('\n').filter(l => l.trim());
      for (const line of historyLines) {
        if (line.startsWith('العميل:')) {
          messages.push({ role: 'user', content: line.replace('العميل:', '').trim() });
        } else if (line.startsWith('البوت:')) {
          messages.push({ role: 'assistant', content: line.replace('البوت:', '').trim() });
        }
      }
    }

    // Add current message
    messages.push({ role: 'user', content: customerMessage });

    try {
      const chatCompletion = await groqClient.chat.completions.create({
        messages,
        model: options.model || 'llama-3.3-70b-versatile',
        temperature,
        max_tokens: maxTokens,
        top_p: 0.9,
      });

      const text = chatCompletion.choices[0]?.message?.content?.trim();
      if (text) return text;

      return 'عذراً، لم أتمكن من فهم طلبك. يرجى المحاولة مرة أخرى.';
    } catch (error) {
      console.error('❌ AI service error:', error.message);
      // Fallback to smaller model if 70b fails
      if (options.model !== 'llama-3.1-8b-instant') {
        try {
          console.log('⚠️ Falling back to smaller AI model...');
          const fallback = await groqClient.chat.completions.create({
            messages,
            model: 'llama-3.1-8b-instant',
            temperature,
            max_tokens: maxTokens,
            top_p: 0.9,
          });
          const fallbackText = fallback.choices[0]?.message?.content?.trim();
          if (fallbackText) return fallbackText;
        } catch (e2) {
          console.error('❌ AI fallback error:', e2.message);
        }
      }
      return 'عذراً، حدث خطأ في معالجة طلبك. يرجى المحاولة لاحقاً.';
    }
  }
}

module.exports = new AIService();
