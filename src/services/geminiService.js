const Groq = require('groq-sdk');

// Models ranked by intelligence (first = smartest)
const MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
];

class AIService {
  constructor() {
    this.groq = null;
    this.customGroq = new Map();
    this.initialized = false;
    this.requestCount = 0;
    this.lastReset = Date.now();
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

  // Track usage to avoid rate limits
  _trackUsage() {
    const now = Date.now();
    // Reset counter every minute
    if (now - this.lastReset > 60000) {
      this.requestCount = 0;
      this.lastReset = now;
    }
    this.requestCount++;
    return this.requestCount;
  }

  // Pick best model based on usage
  _pickModel(preferredModel) {
    const count = this._trackUsage();
    // If making too many requests per minute, use faster model to avoid rate limits
    if (count > 25) {
      console.log(`⚠️ High request rate (${count}/min), using fast model`);
      return 'llama-3.1-8b-instant';
    }
    return preferredModel || MODELS[0];
  }

  async getResponse(systemPrompt, customerMessage, context = {}, options = {}) {
    const startTime = Date.now();
    let groqClient = this.groq;

    // Use custom API key if shopId is provided
    if (context.shopId && this.customGroq.has(context.shopId)) {
      groqClient = this.customGroq.get(context.shopId);
    } else if (!this.initialized) {
      this.initialize();
    }

    if (!groqClient) {
      console.error('❌ AI: No Groq client available');
      return 'عذراً، خدمة الذكاء الاصطناعي غير متاحة حالياً.';
    }

    // Cap tokens to save quota
    const temperature = options.temperature ?? 0.7;
    const maxTokens = Math.min(options.maxTokens ?? 300, 400);

    // Build context (compact)
    let contextStr = '';
    if (context.shopName) contextStr += `الشركة: ${context.shopName}\n`;
    if (context.currentMenu) contextStr += `القائمة: ${context.currentMenu}\n`;
    if (context.menuItems) contextStr += `الخيارات:\n${context.menuItems}\n`;
    if (context.itemContext) contextStr += `السياق: ${context.itemContext}\n`;

    const fullSystemPrompt = contextStr
      ? `${systemPrompt}\n\n${contextStr}`
      : systemPrompt;

    // Arabic-only constraint (bilingual to anchor the model)
    const langRule = 'أجب بالعربية فقط. ALWAYS respond in Arabic. Never use Japanese, Chinese, Korean, or any non-Arabic language.\n\n';

    // Build messages
    const messages = [{ role: 'system', content: langRule + fullSystemPrompt }];

    // Add conversation history as chat turns (keep last 6 turns max)
    if (context.sessionHistory) {
      const lines = context.sessionHistory.split('\n').filter(l => l.trim());
      const recentLines = lines.slice(-6);
      for (const line of recentLines) {
        if (line.startsWith('العميل:')) {
          messages.push({ role: 'user', content: line.replace('العميل:', '').trim() });
        } else if (line.startsWith('البوت:')) {
          messages.push({ role: 'assistant', content: line.replace('البوت:', '').trim() });
        }
      }
    }

    messages.push({ role: 'user', content: customerMessage });

    const selectedModel = this._pickModel(options.model);
    console.log(`🤖 AI call: model=${selectedModel}, tokens=${maxTokens}, msg="${customerMessage.slice(0, 50)}"`);

    // Try with timeout
    for (const model of [selectedModel, ...MODELS.filter(m => m !== selectedModel)]) {
      try {
        const result = await Promise.race([
          groqClient.chat.completions.create({
            messages,
            model,
            temperature,
            max_tokens: maxTokens,
            top_p: 0.9,
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('AI_TIMEOUT')), 15000)
          ),
        ]);

        const text = result.choices[0]?.message?.content?.trim();
        const elapsed = Date.now() - startTime;
        console.log(`✅ AI responded: model=${model}, time=${elapsed}ms, len=${text?.length || 0}`);

        if (text) return text;
      } catch (error) {
        const elapsed = Date.now() - startTime;
        console.error(`❌ AI error (model=${model}, time=${elapsed}ms): ${error.message}`);

        // If timeout or rate limit, try next model
        if (error.message === 'AI_TIMEOUT' || error.status === 429) {
          console.log(`⚠️ Trying next model...`);
          continue;
        }
        // Other error, still try next model
        continue;
      }
    }

    // All models failed
    console.error('❌ All AI models failed');
    return 'عذراً، الخدمة مشغولة حالياً. حاول مرة تانية بعد شوية أو تواصل معنا على 01128511900 📱';
  }
}

module.exports = new AIService();
