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

    // Build context string
    let contextStr = '';
    if (context.shopName) contextStr += `اسم المتجر/الشركة: ${context.shopName}\n`;
    if (context.currentMenu) contextStr += `القائمة الحالية: ${context.currentMenu}\n`;
    if (context.menuItems) contextStr += `عناصر القائمة:\n${context.menuItems}\n`;
    if (context.sessionHistory) contextStr += `سجل المحادثة:\n${context.sessionHistory}\n`;
    if (context.itemContext) contextStr += `سياق العنصر: ${context.itemContext}\n`;

    const fullSystemPrompt = contextStr ? `${systemPrompt}\n\n${contextStr}` : systemPrompt;

    try {
      const chatCompletion = await groqClient.chat.completions.create({
        messages: [
          { role: 'system', content: fullSystemPrompt },
          { role: 'user', content: customerMessage },
        ],
        model: options.model || 'llama-3.1-8b-instant',
        temperature,
        max_tokens: maxTokens,
        top_p: 0.9,
      });

      const text = chatCompletion.choices[0]?.message?.content?.trim();
      if (text) return text;

      return 'عذراً، لم أتمكن من فهم طلبك. يرجى المحاولة مرة أخرى.';
    } catch (error) {
      console.error('❌ AI service error:', error.message);
      return 'عذراً، حدث خطأ في معالجة طلبك. يرجى المحاولة لاحقاً.';
    }
  }
}

module.exports = new AIService();
