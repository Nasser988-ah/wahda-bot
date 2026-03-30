/**
 * Setup script for Nasser's Zaki Bot Marketing Account
 * This configures the AI to be a professional Arabic-speaking Zaki Bot representative
 */

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

const PHONE = '201128511900';

const AI_SYSTEM_PROMPT = `أنت "زكي" - المساعد الذكي الرسمي لتطبيق Zaki Bot، أقوى بوت واتساب ذكي في مصر والعالم العربي.

═══ هويتك ═══
- اسمك: زكي (Zaki)
- دورك: ممثل خدمة عملاء ومبيعات محترف لتطبيق Zaki Bot
- لغتك: العربية الفصحى المبسطة (محترفة وواضحة)
- أسلوبك: ودود، محترف، مقنع، وذكي
- لا تستخدم أي لغة غير العربية إلا إذا طلب العميل ذلك

═══ معلومات عن Zaki Bot ═══

🤖 ما هو Zaki Bot؟
Zaki Bot هو أول بوت واتساب ذكي متكامل في مصر، مصمم خصيصاً للأعمال التجارية والشركات. يعمل بالذكاء الاصطناعي المتقدم ليقدم تجربة خدمة عملاء احترافية على مدار الساعة.

⭐ المميزات الرئيسية:
1. **رد آلي ذكي 24/7** - البوت يرد على عملائك حتى وأنت نائم
2. **ذكاء اصطناعي متقدم** - يفهم اللهجة المصرية والعربية بكل أشكالها
3. **قوائم تفاعلية مخصصة** - صمم قوائمك وخدماتك بالشكل اللي يناسبك
4. **إدارة الطلبات** - استقبال وتتبع طلبات العملاء أوتوماتيك
5. **لوحة تحكم احترافية** - تحكم كامل في البوت من لوحة تحكم سهلة
6. **دعم فني متكامل** - مجموعات دعم واتساب لإدارة المشاكل
7. **إحصائيات وتقارير** - تابع أداء عملك وطلباتك
8. **تخصيص كامل** - خصص الرسائل والردود والقوائم حسب نشاطك

🏢 لمن يصلح Zaki Bot؟
- المطاعم والكافيهات
- محلات الملابس والأحذية
- شركات الإنترنت ومزودي الخدمات (ISP)
- الصيدليات
- محلات الإلكترونيات
- أي نشاط تجاري يحتاج خدمة عملاء على واتساب

💰 الباقات:
- **باقة المتاجر** - للمتاجر التقليدية (منتجات + طلبات + متجر إلكتروني)
- **باقة VIP المخصصة** - للأعمال المتقدمة (قوائم مخصصة + ذكاء اصطناعي + دعم فني)
- كل الباقات تشمل: لوحة تحكم + ذكاء اصطناعي + دعم فني

🔧 كيف يعمل؟
1. تسجل حسابك في النظام
2. تربط رقم الواتساب الخاص بالبوت
3. تضبط القوائم والردود من لوحة التحكم
4. البوت يبدأ يشتغل فوراً ويرد على عملائك

📱 التواصل مع الإدارة:
- للاستفسار أو الاشتراك: 01128511900
- واتساب أو اتصال: 01128511900
- الدعم الفني متاح على مدار الساعة

═══ قواعد مهمة ═══

1. ✅ أجب على كل الأسئلة المتعلقة بـ Zaki Bot باحترافية
2. ✅ شجع العميل على الاشتراك وبين له الفوائد
3. ✅ إذا سأل العميل عن السعر، قل له يتواصل مع الإدارة على 01128511900
4. ✅ إذا أراد العميل الاتصال: رقمنا 01128511900 (هاتف أو واتساب)
5. ✅ كن ودوداً ومحترفاً دائماً
6. ✅ استخدم الإيموجي بشكل معتدل لتحسين التجربة
7. ❌ لا تكشف أي أسرار تقنية عن البوت (كود، قاعدة بيانات، سيرفر، API)
8. ❌ لا تذكر أي تفاصيل عن البنية التحتية أو التكنولوجيا المستخدمة
9. ❌ لا تقل أنك ذكاء اصطناعي من Google أو أي شركة - أنت "زكي" فقط
10. ❌ لا تتحدث عن أسعار محددة - وجّه العميل للتواصل مع الإدارة
11. ❌ لا تتحدث عن المنافسين أو تقارن بأي منتج آخر
12. ❌ لا تعطي معلومات خاطئة أو تخمينات - إذا لم تعرف، وجّه للإدارة

═══ ردود جاهزة ═══

إذا سأل عن السعر:
"أسعارنا مرنة وتناسب كل الميزانيات! 💰 للحصول على عرض سعر مخصص لاحتياجاتك، تواصل مع فريقنا على 01128511900 (واتساب أو اتصال) وهنجهز لك أفضل عرض 🎁"

إذا سأل كيف يشترك:
"الاشتراك سهل جداً! 🚀 تواصل معنا على 01128511900 وفريقنا هيساعدك تبدأ في دقائق. هنعمل لك حساب، نربط الواتساب، ونضبط البوت حسب نشاطك!"

إذا سأل عن الدعم الفني:
"فريق الدعم الفني متاح 24/7! 🛠️ أي مشكلة أو استفسار، تواصل معنا على 01128511900 وهنحلها لك فوراً."`;

const WELCOME_MESSAGE = `مرحباً بك في *Zaki Bot* - أقوى بوت واتساب ذكي! 🤖⚡

أنا زكي، مساعدك الذكي. أقدر أساعدك في:
- معرفة كل شيء عن Zaki Bot
- شرح المميزات والخدمات
- مساعدتك في اختيار الباقة المناسبة
- الإجابة على أي استفسار

اختر من القائمة أو اكتب سؤالك مباشرة! 👇`;

const UNKNOWN_MESSAGE = `عذراً، مش فاهم سؤالك تماماً 🤔

ممكن تسأل عن:
- مميزات Zaki Bot
- الباقات والأسعار
- كيفية الاشتراك
- الدعم الفني

أو اكتب *قائمة* للعودة للقائمة الرئيسية 📋`;

const ORDER_CONFIRM_MESSAGE = `شكراً لاهتمامك! 🎉

تم تسجيل طلبك بنجاح ✅
فريقنا هيتواصل معك في أقرب وقت على رقمك.

للاستفسار: 01128511900 📱`;

async function setup() {
  try {
    console.log('🔍 Looking for nasser account (phone: 201128511900)...');
    
    let shop = await prisma.shop.findUnique({
      where: { phone: PHONE }
    });

    if (!shop) {
      console.log('❌ Shop not found! Creating new shop...');
      const hashedPassword = await bcrypt.hash('nasser', 10);
      shop = await prisma.shop.create({
        data: {
          name: 'Zaki Bot',
          ownerName: 'nasser',
          phone: PHONE,
          whatsappNumber: PHONE,
          shopType: 'custom',
          botType: null,
          subscriptionStatus: 'ACTIVE',
          subscriptionEnd: new Date('2030-12-31'),
          password: hashedPassword,
        }
      });
      console.log('✅ Shop created:', shop.id);
    } else {
      console.log('✅ Found shop:', shop.id, shop.name);
      
      // Update to custom type if needed
      if (shop.shopType !== 'custom') {
        const hashedPassword = await bcrypt.hash('nasser', 10);
        shop = await prisma.shop.update({
          where: { id: shop.id },
          data: { 
            shopType: 'custom',
            subscriptionStatus: 'ACTIVE',
            subscriptionEnd: new Date('2030-12-31'),
            password: hashedPassword,
          }
        });
        console.log('✅ Updated shop to custom type');
      }
    }

    // Create or update BotConfig
    console.log('⚙️ Setting up bot config...');
    const existingConfig = await prisma.botConfig.findUnique({
      where: { shopId: shop.id }
    });

    if (existingConfig) {
      await prisma.botConfig.update({
        where: { shopId: shop.id },
        data: {
          welcomeMessage: WELCOME_MESSAGE,
          unknownMessage: UNKNOWN_MESSAGE,
          orderConfirmMessage: ORDER_CONFIRM_MESSAGE,
          aiSystemPrompt: AI_SYSTEM_PROMPT,
          aiProvider: 'groq',
          aiModel: 'llama-3.3-70b-versatile',
          aiTemperature: 0.7,
          aiMaxTokens: 1000,
          formalityLevel: 2, // Formal
        }
      });
      console.log('✅ Bot config updated');
    } else {
      await prisma.botConfig.create({
        data: {
          shopId: shop.id,
          welcomeMessage: WELCOME_MESSAGE,
          unknownMessage: UNKNOWN_MESSAGE,
          orderConfirmMessage: ORDER_CONFIRM_MESSAGE,
          aiSystemPrompt: AI_SYSTEM_PROMPT,
          aiProvider: 'groq',
          aiModel: 'llama-3.3-70b-versatile',
          aiTemperature: 0.7,
          aiMaxTokens: 1000,
          formalityLevel: 2, // Formal
        }
      });
      console.log('✅ Bot config created');
    }

    // Create main menu
    console.log('📋 Setting up menus...');
    
    // Delete existing menus for this shop
    await prisma.customMenuItem.deleteMany({
      where: { menu: { shopId: shop.id } }
    });
    await prisma.customMenu.deleteMany({
      where: { shopId: shop.id }
    });

    // Create main menu
    const mainMenu = await prisma.customMenu.create({
      data: {
        shopId: shop.id,
        name: 'القائمة الرئيسية',
        description: 'مرحباً بك في Zaki Bot! اختر من القائمة:',
        isActive: true,
        order: 1,
      }
    });

    // Create sub-menus
    const featuresMenu = await prisma.customMenu.create({
      data: {
        shopId: shop.id,
        name: 'مميزات Zaki Bot',
        description: 'تعرف على كل مميزاتنا:',
        isActive: true,
        order: 2,
      }
    });

    const packagesMenu = await prisma.customMenu.create({
      data: {
        shopId: shop.id,
        name: 'الباقات والأسعار',
        description: 'باقاتنا المتاحة:',
        isActive: true,
        order: 3,
      }
    });

    // Main menu items
    const mainItems = [
      { number: 1, label: '🤖 مميزات Zaki Bot', action: 'go_to_menu', actionValue: featuresMenu.id },
      { number: 2, label: '💰 الباقات والأسعار', action: 'go_to_menu', actionValue: packagesMenu.id },
      { number: 3, label: '🚀 كيف أشترك؟', action: 'ai_response', actionValue: null, aiPrompt: 'العميل يسأل عن كيفية الاشتراك في Zaki Bot. اشرح له الخطوات بشكل بسيط ووجهه للتواصل على 01128511900' },
      { number: 4, label: '📱 تواصل مع الإدارة', action: 'custom_message', actionValue: '📱 *تواصل معنا:*\n\n📞 هاتف: 01128511900\n💬 واتساب: 01128511900\n\nفريقنا جاهز لمساعدتك! 🤝' },
      { number: 5, label: '❓ أسئلة شائعة', action: 'ai_response', actionValue: null, aiPrompt: 'العميل يريد معرفة الأسئلة الشائعة عن Zaki Bot. أجب عن أهم 5 أسئلة يسألها العملاء عادة بشكل مختصر ومفيد.' },
    ];

    for (const item of mainItems) {
      await prisma.customMenuItem.create({
        data: {
          menuId: mainMenu.id,
          number: item.number,
          label: item.label,
          action: item.action,
          actionValue: item.actionValue,
          aiPrompt: item.aiPrompt || null,
        }
      });
    }

    // Features menu items
    const featureItems = [
      { number: 1, label: '🤖 الذكاء الاصطناعي', action: 'ai_response', actionValue: null, aiPrompt: 'اشرح للعميل ميزة الذكاء الاصطناعي في Zaki Bot: يفهم اللهجة المصرية، يرد بذكاء، يتعلم من المحادثات. اجعل الشرح مقنع ومحترف.' },
      { number: 2, label: '📋 القوائم التفاعلية', action: 'ai_response', actionValue: null, aiPrompt: 'اشرح للعميل ميزة القوائم التفاعلية المخصصة في Zaki Bot: تصميم قوائم حسب النشاط، أزرار تفاعلية، تنقل سهل. اجعل الشرح مقنع.' },
      { number: 3, label: '📊 لوحة التحكم', action: 'ai_response', actionValue: null, aiPrompt: 'اشرح للعميل لوحة التحكم في Zaki Bot: إحصائيات، إدارة طلبات، تخصيص ردود، سهولة استخدام. اجعل الشرح مقنع.' },
      { number: 4, label: '🛒 إدارة الطلبات', action: 'ai_response', actionValue: null, aiPrompt: 'اشرح للعميل نظام إدارة الطلبات في Zaki Bot: استقبال أوتوماتيك، تتبع، إشعارات. اجعل الشرح مقنع.' },
      { number: 5, label: '🔙 العودة للقائمة الرئيسية', action: 'go_to_menu', actionValue: mainMenu.id },
    ];

    for (const item of featureItems) {
      await prisma.customMenuItem.create({
        data: {
          menuId: featuresMenu.id,
          number: item.number,
          label: item.label,
          action: item.action,
          actionValue: item.actionValue,
          aiPrompt: item.aiPrompt || null,
        }
      });
    }

    // Packages menu items
    const packageItems = [
      { number: 1, label: '🏪 باقة المتاجر', action: 'ai_response', actionValue: null, aiPrompt: 'اشرح للعميل باقة المتاجر في Zaki Bot: مناسبة للمحلات والمطاعم، تشمل متجر إلكتروني + إدارة منتجات + طلبات أونلاين + بوت واتساب ذكي. وجهه للتواصل على 01128511900 للسعر.' },
      { number: 2, label: '⭐ باقة VIP المخصصة', action: 'ai_response', actionValue: null, aiPrompt: 'اشرح للعميل باقة VIP المخصصة في Zaki Bot: مناسبة للشركات الكبيرة ومزودي الخدمات، تشمل قوائم مخصصة + ذكاء اصطناعي متقدم + دعم فني + تخصيص كامل. وجهه للتواصل على 01128511900 للسعر.' },
      { number: 3, label: '💬 طلب عرض سعر', action: 'confirm_order', actionValue: null },
      { number: 4, label: '🔙 العودة للقائمة الرئيسية', action: 'go_to_menu', actionValue: mainMenu.id },
    ];

    for (const item of packageItems) {
      await prisma.customMenuItem.create({
        data: {
          menuId: packagesMenu.id,
          number: item.number,
          label: item.label,
          action: item.action,
          actionValue: item.actionValue,
          aiPrompt: item.aiPrompt || null,
        }
      });
    }

    // Set main menu
    await prisma.botConfig.update({
      where: { shopId: shop.id },
      data: { mainMenuId: mainMenu.id }
    });

    console.log('✅ Menus created and linked');

    console.log('\n═══════════════════════════════════');
    console.log('✅ SETUP COMPLETE!');
    console.log('═══════════════════════════════════');
    console.log(`Shop ID: ${shop.id}`);
    console.log(`Shop Name: ${shop.name}`);
    console.log(`Phone: ${shop.phone}`);
    console.log(`Type: custom`);
    console.log(`AI: Powerful Zaki Bot marketing assistant`);
    console.log(`Language: Arabic (Professional)`);
    console.log(`Contact: 01128511900`);
    console.log('═══════════════════════════════════\n');

  } catch (error) {
    console.error('❌ Setup error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

setup();
