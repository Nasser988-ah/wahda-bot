const { HfInference } = require('@huggingface/inference');

class AIService {
  constructor() {
    // Hugging Face Inference API - free tier (no API key required for basic usage)
    this.hf = new HfInference();
    // Using a free Arabic/English capable model
    this.model = 'microsoft/DialoGPT-medium'; // Good for conversational responses
  }

  async getAIResponse(userMessage, shop, products, cartItems) {
    try {
      // Skip API call and use fallback immediately (Hugging Face requires auth)
      // This ensures fast responses without API errors
      return this.getFallbackResponse(userMessage, shop, products);

    } catch (error) {
      console.error('❌ AI Service Error:', error.message);
      return this.getFallbackResponse(userMessage, shop, products);
    }
  }

  buildContext(shop, products, cartItems) {
    let context = `You are a helpful customer service assistant for ${shop.name}, a shop in Egypt. `;
    context += `Be friendly, simple, and helpful. Answer in the same language the customer uses (Arabic or English).\n\n`;
    
    if (products && products.length > 0) {
      context += 'Available Products:\n';
      products.forEach((p, i) => {
        if (p.isAvailable) {
          context += `${i + 1}. ${p.name} - ${p.price} EGP\n`;
          if (p.description) {
            context += `   Description: ${p.description}\n`;
          }
        }
      });
      context += '\n';
    }

    if (cartItems && cartItems.length > 0) {
      context += `Customer's current cart has ${cartItems.length} items.\n`;
    }

    context += '\nHelp the customer with their questions about products, prices, or how to order. ';
    context += 'Keep responses short (2-3 sentences max) and easy to understand.\n';
    
    return context;
  }

  getFallbackResponse(userMessage, shop, products) {
    const message = userMessage.toLowerCase();
    
    // Simple keyword-based fallback responses
    if (message.includes('مرحبا') || message.includes('سلام') || message.includes('اهلا')) {
      return `أهلاً بيك في ${shop.name}! 😊\nاكتب "قائمة" لتشوف المنتجات المتاحة.`;
    }
    
    if (message.includes('سعر') || message.includes('بكم') || message.includes('كام')) {
      return `عندنا منتجات بأسعار مختلفة. اكتب "قائمة" لتشوف كل المنتجات والأسعار.`;
    }
    
    if (message.includes('طلب') || message.includes('order')) {
      return `عشان تطلب:\n1️⃣ اكتب "قائمة"\n2️⃣ اختار رقم المنتج\n3️⃣ اكتب "اطلب"\n\nسهل جداً! 👍`;
    }
    
    if (message.includes('منتج') || message.includes('عندك ايه')) {
      return `اكتب "قائمة" و هتشوف كل المنتجات اللي عندنا.`;
    }
    
    // Default response
    return `أقدر أساعدك إزاي؟ 🤔\n\nاكتب:\n📋 "قائمة" - لعرض المنتجات\n🛒 "كارت" - لتشوف طلبك\n❓ أو اسألني عن أي حاجة!`;
  }

  // Check if message should be handled by AI (not a command)
  shouldUseAI(message) {
    const commands = ['قائمة', 'menu', 'كارت', 'cart', 'اطلب', 'order', 'الغاء', 'cancel'];
    const isCommand = commands.some(cmd => message.toLowerCase().includes(cmd));
    const isNumber = /^\d+$/.test(message.trim());
    
    // Use AI if it's not a command and not just a number
    return !isCommand && !isNumber;
  }
}

module.exports = new AIService();
