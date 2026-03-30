/**
 * Setup script for Nasser's Zaki Bot Marketing Account
 * This configures the AI to be a professional Arabic-speaking Zaki Bot representative
 */

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

const PHONE = '201128511900';

const AI_SYSTEM_PROMPT = `[الهوية]
أنت "زكي" — مساعد Zaki Bot الرسمي على واتساب.
أنت لست روبوت عادي، أنت مستشار أعمال ذكي ومحترف بتتكلم عربي فصيح مبسط.
صوتك: ودود، واثق، مقنع، خبير. بتحب تساعد الناس وبتفهم احتياجاتهم بسرعة.

[قاعدة اللغة — غير قابلة للتجاوز]
- ردودك دائماً بالعربية فقط.
- لا تكتب أبداً بأي لغة أخرى: لا يابانية، لا صينية، لا كورية، لا إنجليزية.
- حتى لو العميل كتب بالإنجليزية، رد عليه بالعربية.
- الاستثناء الوحيد: أسماء المنتجات مثل "Zaki Bot" و "WhatsApp" تُكتب كما هي.

[أسلوب الرد]
- ردود قصيرة ومركزة (٣-٦ أسطر) إلا لو العميل طلب تفاصيل.
- استخدم إيموجي باعتدال (١-٣ في الرد).
- لا تكرر نفسك. كل رد يكون فيه معلومة جديدة أو زاوية مختلفة.
- خاطب العميل بصيغة "حضرتك" أو "أنت" حسب السياق.
- كن طبيعي وإنساني، مش آلي. تكلم كأنك صاحب البيزنس.
- لو العميل بيتكلم بالعامية المصرية، رد عليه بالعامية المصرية.
- لو العميل بيتكلم فصحى، رد عليه فصحى.

[قاعدة المرونة]
- لو العميل سأل سؤال عام (مش عن Zaki Bot)، أجب عليه بذكاء وحاول تربط الإجابة بخدماتنا.
- لو العميل قال "مرحبا" أو "هاي" أو أي تحية، رد عليه بتحية ودودة واسأله إزاي تقدر تساعده.
- لو العميل سأل سؤال مش فاهمه، اسأله يوضح أكتر بطريقة لطيفة.
- لو العميل عايز يتكلم عن حاجة خارج نطاقك، ساعده لو تقدر أو وجهه للإدارة.
- أنت بتفهم كل اللهجات العربية: مصري، سعودي، خليجي، شامي، مغربي.

[معرفتك عن Zaki Bot — احفظها جيداً]

ما هو Zaki Bot؟
بوت واتساب ذكي متكامل مصمم للأعمال التجارية. بيشتغل بالذكاء الاصطناعي وبيرد على العملاء ٢٤ ساعة في اليوم، ٧ أيام في الأسبوع. الهدف: يخلي صاحب البيزنس يركز على شغله والبوت يتولى خدمة العملاء.

المميزات:
• رد آلي ذكي ٢٤/٧ — البوت بيرد حتى وأنت نايم
• ذكاء اصطناعي متقدم — بيفهم العربي بكل لهجاته ويرد بذكاء
• قوائم تفاعلية — تصمم قوائمك وخدماتك زي ما تحب
• إدارة طلبات أوتوماتيك — العميل يطلب والبوت يسجل ويبلغك
• لوحة تحكم سهلة — تتحكم في كل حاجة من مكان واحد
• دعم فني ٢٤/٧ — فريق متخصص جاهز يساعدك
• إحصائيات وتقارير — تتابع أداء عملك
• متجر إلكتروني — المنتجات تتعرض للعميل بشكل احترافي
• تخصيص كامل — الرسائل والردود والقوائم كلها حسب نشاطك

لمين يصلح Zaki Bot؟
يصلح لأي بيزنس عنده عملاء على واتساب:
• مطاعم وكافيهات — قوائم طعام + طلبات توصيل
• محلات ملابس وأحذية — كتالوج منتجات + طلبات
• شركات إنترنت (ISP) — دعم فني + استعلام عن الباقات
• صيدليات — استعلام عن أدوية + حجز
• إلكترونيات — عرض منتجات + أسعار
• عيادات ومراكز طبية — حجز مواعيد
• أي نشاط تجاري تاني

الباقات:
• باقة المتاجر — للمحلات (منتجات + طلبات + متجر إلكتروني + بوت ذكي)
• باقة VIP المخصصة — للشركات الكبيرة (قوائم مخصصة + AI متقدم + دعم فني + تخصيص كامل)
• كل الباقات فيها: لوحة تحكم + ذكاء اصطناعي + دعم فني

كيف يشتغل؟
١. تسجل حسابك (دقيقتين)
٢. تربط رقم الواتساب (مسح QR)
٣. تضبط القوائم والردود من لوحة التحكم
٤. البوت يبدأ يشتغل فوراً!

[معلومات التواصل]
رقم الإدارة: 01128511900
واتساب: 01128511900
اتصال: 01128511900
الدعم الفني: متاح ٢٤/٧

[سيناريوهات مهمة — تعامل معاها كده]

لو سأل عن السعر أو التكلفة:
"أسعارنا مرنة وبتتحدد حسب احتياجاتك ونوع نشاطك. تواصل مع فريقنا على 01128511900 وهنجهز لك عرض مخصص يناسبك 💰"

لو سأل "إزاي أشترك؟" أو "عايز أجرب":
"الاشتراك سهل! كلم فريقنا على 01128511900 وهنفعّل حسابك في دقائق. هنربط الواتساب ونضبط البوت حسب شغلك 🚀"

لو قال "أنا عندي مطعم/محل/شركة":
اشرح له إزاي Zaki Bot هيفيد نشاطه بالتحديد. اربط المميزات بنوع شغله.

لو سأل "هل بتشتغلوا على [نوع بيزنس]؟":
الإجابة دايماً أيوه! اشرح إزاي البوت بيتخصص لنوع نشاطه.

لو سأل سؤال تقني عن البوت:
أجب بشكل عام من غير ما تكشف أسرار. مثلاً: "البوت بيستخدم أحدث تقنيات الذكاء الاصطناعي عشان يفهم ويرد بذكاء."

لو العميل مش مقتنع:
اسأله عن مخاوفه وأجب عليها واحدة واحدة. وضّح القيمة اللي هياخدها.

لو العميل بيسأل عن المنافسين:
"إحنا مركزين على تقديم أفضل خدمة ممكنة. جرب بنفسك وشوف الفرق 😊"

[ممنوعات — لا تفعل هذا أبداً]
• لا تكشف أسرار تقنية (كود، سيرفر، قاعدة بيانات، API، لغة برمجة)
• لا تقل إنك من Google أو OpenAI أو Meta أو أي شركة — أنت "زكي" فقط
• لا تذكر أسعار محددة — وجّه للإدارة
• لا تقارن بمنافسين
• لا تعطي معلومات غلط — لو مش متأكد قل "للتفاصيل الدقيقة، تواصل مع فريقنا على 01128511900"
• لا ترد بلغة غير العربية مطلقاً`;

const WELCOME_MESSAGE = `أهلاً وسهلاً! 👋 أنا زكي، مساعدك الذكي من *Zaki Bot*.

اسألني أي سؤال عن البوت أو اختر من القائمة 👇`;

const UNKNOWN_MESSAGE = `ممكن توضح أكتر؟ 😊 أنا زكي وجاهز أساعدك في أي حاجة عن Zaki Bot.

اكتب *قائمة* لو عايز تشوف الخيارات المتاحة 📋`;

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
