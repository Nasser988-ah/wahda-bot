/**
 * Setup script for Archers for Shooting Sports VIP account
 * Phone: 201101222922
 */

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

const PHONE = '201101222922';
const NOTIFY_PHONE = '201128511900'; // Management WhatsApp for order notifications

const AI_SYSTEM_PROMPT = `[الهوية]
أنت المساعد الذكي الرسمي لـ *Archers for Shooting Sports* — أكاديمية رياضات الرماية الأولى.
أنت مستشار رياضي محترف، شغوف بالرياضة وعارف كل التفاصيل عن البرامج التدريبية.
صوتك: حماسي، مقنع، محترف، ودود. بتحب تساعد الناس يكتشفوا شغفهم بالرماية.

[قاعدة اللغة — غير قابلة للتجاوز]
- ردودك دائماً بالعربية فقط.
- لا تكتب بأي لغة أخرى أبداً.
- حتى لو العميل كتب بالإنجليزية، رد عليه بالعربية.
- الاستثناء الوحيد: اسم "Archers for Shooting Sports" يُكتب كما هو.

[أسلوب الرد]
- ردود قصيرة ومركزة (٣-٦ أسطر) إلا لو العميل طلب تفاصيل.
- استخدم إيموجي باعتدال (١-٣ في الرد).
- خاطب العميل بصيغة "حضرتك" أو "أنت" حسب السياق.
- كن حماسي ومقنع — الهدف إن العميل يحجز تجربة أو برنامج.
- لو العميل بيتكلم بالعامية المصرية، رد عليه بالعامية.
- لو العميل بيتكلم فصحى، رد عليه فصحى.

[مهمتك الأساسية — الإقناع]
أهم حاجة هي إقناع العميل بأهمية الرماية:
- الرماية مش مجرد هواية — دي رياضة أولمبية حقيقية وعالمية
- بتحسن التركيز والثقة بالنفس والهدوء تحت الضغط
- بتعلم الانضباط والصبر والدقة
- مناسبة لكل الأعمار (أطفال، شباب، كبار)
- بتقوي الصحة النفسية وبتقلل التوتر
- مهارة فريدة بتميزك عن أي حد تاني
- بيئة آمنة ١٠٠٪ مع مدربين محترفين
- رياضة بتجمع بين القوة الذهنية والبدنية

[البرامج التدريبية]

برنامج المبتدئين:
• مناسب لأي حد أول مرة يمسك سلاح
• تعليم أساسيات الرماية والأمان
• تدريب على أنواع مختلفة من الأسلحة
• مدة البرنامج مرنة حسب مستوى المتدرب

برنامج المتقدمين:
• للي عندهم خبرة سابقة في الرماية
• تقنيات متقدمة وتحسين الدقة
• تدريب على المنافسات
• إعداد للبطولات المحلية والدولية

برنامج الأطفال والناشئين:
• للأعمار من ١٠ سنين فما فوق
• بيئة آمنة ومراقبة بالكامل
• تعليم الانضباط والتركيز
• بناء شخصية قوية وواثقة

برنامج الشركات والمجموعات:
• أنشطة Team Building فريدة
• تجارب جماعية ممتعة
• مناسب للشركات والأصدقاء والعائلات

التجربة المجانية / زيارة تعريفية:
• متاحة لأي حد عايز يجرب قبل ما يلتزم
• بنعرفك على المكان والمدربين والأسلحة
• من غير أي التزام

[الرياضات المتاحة]
• رماية بالمسدس (Pistol Shooting)
• رماية بالبندقية (Rifle Shooting)
• رماية بالقوس والسهم (Archery)
• الرماية الأولمبية (Olympic Shooting)

[نظام الحجز والاشتراك]
١. العميل يختار البرنامج المناسب
٢. يدفع حجز ١٠٪ من قيمة البرنامج
٣. فريق الحسابات يأكد الدفع
٤. الإداري بتاع الفرع يتواصل مع العميل ويبدأ المتابعة
٥. يبدأ التدريب!

[معلومات التواصل]
رقم الإدارة: 01128511900
واتساب: 01128511900

[سيناريوهات مهمة]

لو سأل "عايز أجرب" أو "ممكن زيارة":
"طبعاً! عندنا تجربة تعريفية متاحة. هتتعرف على المكان والمدربين وتجرب بنفسك. كل اللي محتاجه تبعتلي اسمك ورقمك وفريقنا هيتواصل معاك يحددوا ميعاد مناسب 🎯"

لو سأل عن الأسعار:
"أسعارنا بتختلف حسب البرنامج ومدته. الحجز بيكون ١٠٪ من قيمة البرنامج. تواصل مع فريقنا على 01128511900 وهنجهزلك عرض مخصص يناسبك 💰"

لو سأل "هل الرماية آمنة؟":
"الأمان أولويتنا الأولى! عندنا مدربين محترفين معتمدين، ومعدات أمان كاملة، وبيئة مراقبة بالكامل. كل متدرب بيأخد تدريب أمان قبل ما يبدأ 🛡️"

لو مش مقتنع أو متردد:
اسأله عن مخاوفه وأجب عليها. ركز على الفوائد الصحية والنفسية. اعرض عليه التجربة المجانية.

لو عايز يحجز:
"ممتاز! 🎉 ابعتلي اسمك الكامل ورقم تليفونك وفريقنا هيتواصل معاك في أقرب وقت لتأكيد الحجز وتحديد ميعاد البداية."

[ممنوعات]
• لا تكشف أسرار تقنية عن البوت أو النظام
• لا تذكر أسعار محددة بالأرقام — وجّه للإدارة
• لا تعطي معلومات غلط — لو مش متأكد قل "تواصل مع فريقنا على 01128511900"
• لا ترد بلغة غير العربية مطلقاً
• لا تتكلم عن أسلحة بشكل يخوف — ركز على الجانب الرياضي والأمان`;

const WELCOME_MESSAGE = `أهلاً وسهلاً في *Archers for Shooting Sports*! 🎯

أنا مساعدك الذكي، جاهز أساعدك تعرف كل حاجة عن رياضات الرماية والبرامج التدريبية.

اختر من القائمة أو اكتب سؤالك مباشرة 👇`;

const UNKNOWN_MESSAGE = `ممكن توضح أكتر؟ 😊 أنا جاهز أساعدك في أي حاجة عن برامجنا التدريبية ورياضات الرماية.

اكتب *قائمة* لو عايز تشوف الخيارات المتاحة 📋`;

const ORDER_CONFIRM_MESSAGE = `شكراً لاهتمامك! 🎯🎉

تم تسجيل بياناتك بنجاح ✅
فريقنا هيتواصل معاك في أقرب وقت لتأكيد الحجز وتحديد ميعاد مناسب.

للاستفسار: 01128511900 📱`;

async function setup() {
  try {
    console.log('🔍 Looking for Archers account (phone: 201101222922)...');
    
    let shop = await prisma.shop.findUnique({
      where: { phone: PHONE }
    });

    if (!shop) {
      console.log('❌ Shop not found! Creating new shop...');
      const hashedPassword = await bcrypt.hash('p28rm6ejA1!', 10);
      shop = await prisma.shop.create({
        data: {
          name: 'Archers for Shooting Sports',
          ownerName: 'Archers',
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
    }

    // Create or update BotConfig
    console.log('⚙️ Setting up bot config...');
    const existingConfig = await prisma.botConfig.findUnique({
      where: { shopId: shop.id }
    });

    const configData = {
      welcomeMessage: WELCOME_MESSAGE,
      unknownMessage: UNKNOWN_MESSAGE,
      orderConfirmMessage: ORDER_CONFIRM_MESSAGE,
      aiSystemPrompt: AI_SYSTEM_PROMPT,
      aiProvider: 'groq',
      aiModel: 'llama-3.3-70b-versatile',
      aiTemperature: 0.7,
      aiMaxTokens: 400,
      formalityLevel: 2,
    };

    if (existingConfig) {
      await prisma.botConfig.update({
        where: { shopId: shop.id },
        data: configData
      });
      console.log('✅ Bot config updated');
    } else {
      await prisma.botConfig.create({
        data: { shopId: shop.id, ...configData }
      });
      console.log('✅ Bot config created');
    }

    // Create menus
    console.log('📋 Setting up menus...');
    
    // Delete existing menus
    await prisma.customMenuItem.deleteMany({
      where: { menu: { shopId: shop.id } }
    });
    await prisma.customMenu.deleteMany({
      where: { shopId: shop.id }
    });

    // Main menu
    const mainMenu = await prisma.customMenu.create({
      data: {
        shopId: shop.id,
        name: 'القائمة الرئيسية',
        description: 'القائمة الرئيسية لـ Archers',
        order: 0,
        isActive: true,
      }
    });

    // Sub menus
    const programsMenu = await prisma.customMenu.create({
      data: {
        shopId: shop.id,
        name: 'البرامج التدريبية',
        description: 'تفاصيل البرامج التدريبية',
        order: 1,
        isActive: true,
      }
    });

    const sportsMenu = await prisma.customMenu.create({
      data: {
        shopId: shop.id,
        name: 'الرياضات المتاحة',
        description: 'أنواع رياضات الرماية',
        order: 2,
        isActive: true,
      }
    });

    // Main menu items
    await prisma.customMenuItem.createMany({
      data: [
        { menuId: mainMenu.id, number: 1, label: '🎯 البرامج التدريبية', action: 'go_to_menu', actionValue: programsMenu.id },
        { menuId: mainMenu.id, number: 2, label: '🏹 الرياضات المتاحة', action: 'go_to_menu', actionValue: sportsMenu.id },
        { menuId: mainMenu.id, number: 3, label: '🆓 أحجز تجربة / زيارة', action: 'confirm_order', actionValue: NOTIFY_PHONE },
        { menuId: mainMenu.id, number: 4, label: '💰 الأسعار والباقات', action: 'ai_response', aiPrompt: AI_SYSTEM_PROMPT },
        { menuId: mainMenu.id, number: 5, label: '📱 تواصل مع الإدارة', action: 'custom_message', actionValue: `للتواصل مع الإدارة مباشرة:\n📱 واتساب: 01128511900\n📞 اتصال: 01128511900\n\nفريقنا جاهز يساعدك! 🤝` },
      ]
    });

    // Programs submenu items
    await prisma.customMenuItem.createMany({
      data: [
        { menuId: programsMenu.id, number: 1, label: '🎯 برنامج المبتدئين', action: 'ai_response' },
        { menuId: programsMenu.id, number: 2, label: '🏆 برنامج المتقدمين', action: 'ai_response' },
        { menuId: programsMenu.id, number: 3, label: '👧 برنامج الأطفال والناشئين', action: 'ai_response' },
        { menuId: programsMenu.id, number: 4, label: '🏢 برنامج الشركات والمجموعات', action: 'ai_response' },
        { menuId: programsMenu.id, number: 5, label: '📝 احجز الآن', action: 'confirm_order', actionValue: NOTIFY_PHONE },
        { menuId: programsMenu.id, number: 6, label: '🔙 العودة للقائمة الرئيسية', action: 'go_to_menu', actionValue: mainMenu.id },
      ]
    });

    // Sports submenu items
    await prisma.customMenuItem.createMany({
      data: [
        { menuId: sportsMenu.id, number: 1, label: '🔫 رماية بالمسدس', action: 'ai_response' },
        { menuId: sportsMenu.id, number: 2, label: '🎯 رماية بالبندقية', action: 'ai_response' },
        { menuId: sportsMenu.id, number: 3, label: '🏹 رماية بالقوس والسهم', action: 'ai_response' },
        { menuId: sportsMenu.id, number: 4, label: '🥇 الرماية الأولمبية', action: 'ai_response' },
        { menuId: sportsMenu.id, number: 5, label: '📝 احجز تجربة', action: 'confirm_order', actionValue: NOTIFY_PHONE },
        { menuId: sportsMenu.id, number: 6, label: '🔙 العودة للقائمة الرئيسية', action: 'go_to_menu', actionValue: mainMenu.id },
      ]
    });

    // Link main menu to config
    await prisma.botConfig.update({
      where: { shopId: shop.id },
      data: { mainMenuId: mainMenu.id }
    });
    console.log('✅ Menus created and linked');

    // Ensure admin record exists
    const adminEmail = `${PHONE}@wahdabot.com`;
    const existingAdmin = await prisma.admin.findFirst({ where: { email: adminEmail } });
    if (!existingAdmin) {
      const hashedPassword = await bcrypt.hash('p28rm6ejA1!', 10);
      await prisma.admin.create({ data: { email: adminEmail, password: hashedPassword } });
      console.log('✅ Admin record created');
    }

    console.log(`
═══════════════════════════════════
✅ SETUP COMPLETE!
═══════════════════════════════════
Shop ID: ${shop.id}
Shop Name: Archers for Shooting Sports
Phone: ${PHONE}
Type: custom
AI: Shooting Sports consultant
Language: Arabic (Professional)
Notify: ${NOTIFY_PHONE} (WhatsApp)
Login: ${PHONE} / ${PHONE}
═══════════════════════════════════
`);

  } catch (error) {
    console.error('❌ Setup error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

setup();
