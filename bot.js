require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');

// Bot token
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

// MongoDB ulanish
mongoose.connect(process.env.MONGODB_URI, { 
    useNewUrlParser: true, 
    useUnifiedTopology: true 
});

// Modellar
const userSchema = new mongoose.Schema({
    userId: { type: Number, required: true, unique: true },
    username: String,
    firstName: String,
    lastName: String,
    balance: { type: Number, default: 0 },
    subscribed: { type: Boolean, default: false },
    lastSelectedCurrency: String,
    lastSelectedMethod: String,
    createdAt: { type: Date, default: Date.now }
});

const transactionSchema = new mongoose.Schema({
    userId: { type: Number, required: true },
    fromCurrency: String,
    toCurrency: String,
    amount: Number,
    fee: Number,
    totalAmount: Number,
    paymentMethod: String,
    paymentDetails: String,
    screenshot: String,
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    adminMessageId: Number,
    createdAt: { type: Date, default: Date.now }
});

// Kodning boshiga qo'shing
const adminState = {
    announcementPhoto: null
};

const User = mongoose.model('User', userSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);

// Konfiguratsiya
const config = {
    adminId: parseInt(process.env.ADMIN_ID),
    requiredChannels: ['@news0877'], // Obuna bo'lish kerak bo'lgan kanallar
    fees: [
        { min: 20000, max: 50000, fee: 5000 },
        { min: 51000, max: 80000, fee: 8000 },
        { min: 81000, max: 150000, fee: 10000 }
    ],
    minAmount: 20000,
    currencies: ['PAYEER USD', 'DOGECOIN', 'TONCOIN', 'USDT', 'QIWI RUB'],
    paymentMethods: {
        'HUMO Card': {
            details: '9860 1234 5678 9012',
            owner: 'John Doe',
            bank: 'Kapitalbank'
        },
        'UzCard': {
            details: '8600 1234 5678 9012',
            owner: 'John Doe',
            bank: 'Xalq Banki'
        },
        'Payeer RUB': {
            details: 'P12345678',
            owner: 'John Doe',
            bank: 'Payeer'
        },
        'Dogecoin': {
            details: 'DHjgk234kjh5234kjh34',
            owner: '',
            bank: 'Dogecoin Network'
        },
        'Toncoin': {
            details: 'EQAB234kjh5234kjh34kjh5234kjh34',
            owner: '',
            bank: 'TON Network'
        },
        'Bank Transfer': {
            details: 'Tinkoff Bank 1234567890',
            owner: 'John Doe',
            bank: 'Tinkoff Bank'
        }
    },
        exchangeRates: {
        'UZS': {
            'QIWI RUB': 0.0075,  // 1 UZS = 0.0075 RUB
            'USDT': 0.000080,    // 1 UZS = 0.000080 USDT
            'DOGECOIN': 0.00025, // 1 UZS = 0.00025 DOGE
            'BTC': 0.0000000025  // 1 UZS = 0.0000000025 BTC
        },
        'QIWI RUB': {
            'UZS': 133.33,
            'USDT': 0.0107,
            'DOGECOIN': 0.033,
            'BTC': 0.00000033
        },
        // ... boshqa valyuta kurslari ...
    },
    serviceFeePercentage: 0.1, // 10% xizmat haqqi
    minServiceFee: 5000,       // Minimal xizmat haqqi (UZS)
    maxServiceFee: 20000       // Maksimal xizmat haqqi (UZS)
};

function convertCurrency(amount, fromCurrency, toCurrency) {
    if (fromCurrency === toCurrency) return amount;
    
    const rate = config.exchangeRates[fromCurrency]?.[toCurrency];
    if (!rate) throw new Error(`Konvertatsiya kursi topilmadi: ${fromCurrency} -> ${toCurrency}`);
    
    return amount * rate;
}

function calculateServiceFee(amount, currency) {
    // Xizmat haqqini UZSda hisoblaymiz
    let feeInUzs = amount * config.serviceFeePercentage;
    
    // Agar boshqa valyutada bo'lsa, UZSga konvertatsiya qilamiz
    if (currency !== 'UZS') {
        feeInUzs = convertCurrency(amount, currency, 'UZS') * config.serviceFeePercentage;
    }
    
    // Minimal va maksimal chegaralarni tekshiramiz
    feeInUzs = Math.max(feeInUzs, config.minServiceFee);
    feeInUzs = Math.min(feeInUzs, config.maxServiceFee);
    
    // Kerakli valyutaga konvertatsiya qilamiz
    if (currency !== 'UZS') {
        return convertCurrency(feeInUzs, 'UZS', currency);
    }
    
    return feeInUzs;
}

// Yordamchi funksiyalar
function calculateFee(amount) {
    for (const range of config.fees) {
        if (amount >= range.min && amount <= range.max) {
            return range.fee;
        }
    }
    return Math.min(amount * 0.1, 10000);
}

async function checkSubscription(userId) {
    try {
        for (const channel of config.requiredChannels) {
            const member = await bot.getChatMember(channel, userId);
            if (member.status === 'left' || member.status === 'kicked') {
                return false;
            }
        }
        return true;
    } catch (error) {
        console.error('Obunani tekshirishda xato:', error);
        return false;
    }
}

// Bot komandalari
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    try {
        // Foydalanuvchini yaratish yoki yangilash
        let user = await User.findOneAndUpdate(
            { userId },
            {
                username: msg.from.username,
                firstName: msg.from.first_name,
                lastName: msg.from.last_name
            },
            { upsert: true, new: true }
        );
        
        // Obunani tekshirish
        const isSubscribed = await checkSubscription(userId);
        if (!isSubscribed) {
            const subscribeKeyboard = {
                inline_keyboard: [
                    ...config.requiredChannels.map(ch => [{ 
                        text: `Obuna bo'lish ${ch}`, 
                        url: `https://t.me/${ch.replace('@', '')}` 
                    }]),
                    [{ text: "✅ Obuna bo'ldim", callback_data: 'check_subscription' }]
                ]
            };
            
            return bot.sendMessage(chatId, 'Botdan foydalanish uchun quyidagi kanallarga obuna bo\'ling:', {
                reply_markup: subscribeKeyboard
            });
        }
        
        // Asosiy menyu
        user.subscribed = true;
        await user.save();
        
        const mainMenu = {
            reply_markup: {
                keyboard: [
                    ['💵 Pul Ayirboshlash'],
                    ['📋 Mening tranzaksiyalarim', '📞 Admin bilan bog\'lanish']
                ],
                resize_keyboard: true
            }
        };
        
        bot.sendMessage(chatId, 'Asosiy menyu:', mainMenu);
    } catch (error) {
        console.error('/start buyrug\'ida xato:', error);
        bot.sendMessage(chatId, 'Xatolik yuz berdi. Iltimos, qayta urinib ko\'ring.');
    }
});

// Callback query
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const userId = callbackQuery.from.id;
    const data = callbackQuery.data;
    
    try {
        if (data === 'check_subscription') {
            const isSubscribed = await checkSubscription(userId);
            if (isSubscribed) {
                await User.findOneAndUpdate({ userId }, { subscribed: true });
                bot.deleteMessage(chatId, callbackQuery.message.message_id);
                
                const mainMenu = {
                    reply_markup: {
                        keyboard: [
                            ['💵 Pul Ayirboshlash'],
                            ['📋 Mening tranzaksiyalarim', '📞 Admin bilan bog\'lanish']
                        ],
                        resize_keyboard: true
                    }
                };
                
                bot.sendMessage(chatId, 'Asosiy menyu:', mainMenu);
            } else {
                bot.answerCallbackQuery(callbackQuery.id, {
                    text: 'Iltimos, barcha kanallarga obuna bo\'ling!',
                    show_alert: true
                });
            }
        } else if (data.startsWith('currency_')) {
            const currency = data.split('_')[1];
            await User.findOneAndUpdate({ userId }, { lastSelectedCurrency: currency });
            
            const paymentMethodsKeyboard = {
                inline_keyboard: Object.keys(config.paymentMethods).map(method => ([
                    { text: method, callback_data: `method_${method}` }
                ]))
            };
            
            bot.editMessageText(`Tanlangan valyuta: ${currency}\n\nTo'lov usulini tanlang:`, {
                chat_id: chatId,
                message_id: callbackQuery.message.message_id,
                reply_markup: paymentMethodsKeyboard
            });
        } else if (data.startsWith('method_')) {
            const method = data.split('_')[1];
            await User.findOneAndUpdate({ userId }, { lastSelectedMethod: method });
            
            bot.editMessageText(`Tanlangan to'lov usuli: ${method}\n\nOlishni xohlagan summani kiriting (minimal ${config.minAmount}):`, {
                chat_id: chatId,
                message_id: callbackQuery.message.message_id,
                reply_markup: { inline_keyboard: [[{ text: '❌ Bekor qilish', callback_data: 'cancel_transaction' }]] }
            });
        } else if (data === 'cancel_transaction') {
            bot.deleteMessage(chatId, callbackQuery.message.message_id);
            bot.sendMessage(chatId, 'Tranzaksiya bekor qilindi.');
        } else if (data.startsWith('admin_approve_')) {
            if (callbackQuery.from.id !== config.adminId) {
                bot.answerCallbackQuery(callbackQuery.id, { text: 'Faqat admin bu amalni bajara oladi', show_alert: true });
                return;
            }
            
            const transactionId = data.split('_')[2];
            const transaction = await Transaction.findById(transactionId);
            
            if (!transaction) {
                bot.answerCallbackQuery(callbackQuery.id, { text: 'Tranzaksiya topilmadi', show_alert: true });
                return;
            }
            
            transaction.status = 'approved';
            await transaction.save();
            
            // Foydalanuvchi balansini yangilash
            await User.findOneAndUpdate(
                { userId: transaction.userId },
                { $inc: { balance: transaction.amount } }
            );
            
            // Foydalanuvchiga xabar
            bot.sendMessage(transaction.userId, 
                `✅ Sizning ${transaction.amount} ${transaction.toCurrency} miqdordagi tranzaksiyangiz tasdiqlandi!\n\n` +
                `Endi sizning balansingiz: ${transaction.amount} ${transaction.toCurrency}`
            );
            
            // Admin xabarini yangilash
            bot.editMessageText(
                `Tranzaksiya #${transaction._id}\n\n` +
                `Holat: ✅ TASDIQLANDI\n\n` +
                `Foydalanuvchi: @${callbackQuery.from.username || 'noma\'lum'} (ID: ${transaction.userId})\n` +
                `Olmoqchi: ${transaction.amount} ${transaction.toCurrency}\n` +
                `To'lov usuli: ${transaction.paymentMethod}\n` +
                `To'langan: ${transaction.totalAmount} ${transaction.fromCurrency}\n` +
                `Xizmat haqqi: ${transaction.fee} ${transaction.toCurrency}\n` +
                `Karta/Hisob: ${transaction.paymentDetails}`,
                {
                    chat_id: chatId,
                    message_id: callbackQuery.message.message_id,
                    reply_markup: { inline_keyboard: [] }
                }
            );
            
            bot.answerCallbackQuery(callbackQuery.id, { text: 'Tranzaksiya tasdiqlandi' });
        } else if (data.startsWith('admin_reject_')) {
            if (callbackQuery.from.id !== config.adminId) {
                bot.answerCallbackQuery(callbackQuery.id, { text: 'Faqat admin bu amalni bajara oladi', show_alert: true });
                return;
            }
            
            const transactionId = data.split('_')[2];
            const transaction = await Transaction.findById(transactionId);
            
            if (!transaction) {
                bot.answerCallbackQuery(callbackQuery.id, { text: 'Tranzaksiya topilmadi', show_alert: true });
                return;
            }
            
            transaction.status = 'rejected';
            await transaction.save();
            
            // Foydalanuvchiga xabar
            bot.sendMessage(
                transaction.userId,
                `❌ Sizning ${transaction.amount} ${transaction.toCurrency} miqdordagi tranzaksiyangiz rad etildi.\n\n` +
                `Sabab: To'lov tasdiqlanmadi.\n` +
                `Agar bu xato deb o'ylasangiz, admin bilan bog'laning.`
            );
            
            // Admin xabarini yangilash
            bot.editMessageText(
                `Tranzaksiya #${transaction._id}\n\n` +
                `Holat: ❌ RAD ETILDI\n\n` +
                `Foydalanuvchi: @${callbackQuery.from.username || 'noma\'lum'} (ID: ${transaction.userId})\n` +
                `Olmoqchi: ${transaction.amount} ${transaction.toCurrency}\n` +
                `To'lov usuli: ${transaction.paymentMethod}\n` +
                `To'langan: ${transaction.totalAmount} ${transaction.fromCurrency}\n` +
                `Xizmat haqqi: ${transaction.fee} ${transaction.toCurrency}\n` +
                `Karta/Hisob: ${transaction.paymentDetails}`,
                {
                    chat_id: chatId,
                    message_id: callbackQuery.message.message_id,
                    reply_markup: { inline_keyboard: [] }
                }
            );
            
            bot.answerCallbackQuery(callbackQuery.id, { text: 'Tranzaksiya rad etildi' });
        }
    } catch (error) {
        console.error('Callback query xatosi:', error);
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Xatolik yuz berdi', show_alert: true });
    }
});

// Xabarlarni qayta ishlash
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;
    
    try {
        // Obunani tekshirish
        const user = await User.findOne({ userId });
        if (!user?.subscribed) {
            const isSubscribed = await checkSubscription(userId);
            if (!isSubscribed) {
                const subscribeKeyboard = {
                    inline_keyboard: [
                        ...config.requiredChannels.map(ch => [{ 
                            text: `Obuna bo'lish ${ch}`, 
                            url: `https://t.me/${ch.replace('@', '')}` 
                        }]),
                        [{ text: "✅ Obuna bo'ldim", callback_data: 'check_subscription' }]
                    ]
                };
                
                return bot.sendMessage(chatId, 'Botdan foydalanish uchun quyidagi kanallarga obuna bo\'ling:', {
                    reply_markup: subscribeKeyboard
                });
            }
            await User.findOneAndUpdate({ userId }, { subscribed: true });
        }
        
        if (text === '💵 Pul Ayirboshlash') {
            const currenciesKeyboard = {
                reply_markup: {
                    inline_keyboard: config.currencies.map(currency => [
                        { text: currency, callback_data: `currency_${currency}` }
                    ])
                }
            };
            
            bot.sendMessage(chatId, 'Qaysi valyutada pul olishni xohlaysiz?', currenciesKeyboard);
        } else if (text === '📋 Mening tranzaksiyalarim') {
            const transactions = await Transaction.find({ userId })
                .sort({ createdAt: -1 })
                .limit(10);
            
            if (transactions.length === 0) {
                bot.sendMessage(chatId, 'Sizda hali tranzaksiyalar mavjud emas.');
                return;
            }
            
            for (const tx of transactions) {
                const statusEmoji = tx.status === 'approved' ? '✅' : 
                                  tx.status === 'rejected' ? '❌' : '⏳';
                const message = 
                    `Tranzaksiya #${tx._id}\n\n` +
                    `Holat: ${statusEmoji} ${tx.status}\n` +
                    `Valyuta: ${tx.toCurrency}\n` +
                    `Miqdor: ${tx.amount}\n` +
                    `Xizmat haqqi: ${tx.fee}\n` +
                    `To'lov usuli: ${tx.paymentMethod}\n` +
                    `Sana: ${tx.createdAt.toLocaleString()}\n\n`;
                
                if (tx.status === 'approved') {
                    bot.sendMessage(chatId, message + `✅ Muvaffaqiyatli amalga oshirildi`);
                } else if (tx.status === 'rejected') {
                    bot.sendMessage(chatId, message + `❌ Rad etilgan. Admin bilan bog'laning.`);
                } else {
                    bot.sendMessage(chatId, message + `⏳ Ko'rib chiqilmoqda...`);
                }
            }
        } else if (text === '📞 Admin bilan bog\'lanish') {
            bot.sendMessage(chatId, 'Xabaringizni yuboring. U adminga yuboriladi va ular sizga javob berishadi.');
        } else if (user.lastSelectedMethod && !isNaN(text)) {
            const amount = parseInt(text);
            const fee = calculateFee(amount);
            const totalAmount = amount + fee;
            
            if (amount < config.minAmount) {
                bot.sendMessage(chatId, `Minimal summa ${config.minAmount}. Iltimos, kattaroq summa kiriting.`);
                return;
            }
            
            // To'lov ma'lumotlari
            const methodInfo = config.paymentMethods[user.lastSelectedMethod];
            const paymentDetails = `${methodInfo.details} ${methodInfo.owner ? `(${methodInfo.owner})` : ''}`;
            
            // Tranzaksiyani yaratish
            const transaction = new Transaction({
                userId,
                fromCurrency: user.lastSelectedMethod,
                toCurrency: user.lastSelectedCurrency,
                amount,
                fee,
                totalAmount,
                paymentMethod: user.lastSelectedMethod,
                paymentDetails: paymentDetails,
                status: 'pending'
            });
            
            await transaction.save();
            
            // Foydalanuvchiga to'lov ma'lumotlarini yuborish
            const paymentMessage = 
                `💳 To'lov uchun ma'lumotlar:\n\n` +
                `Bank: ${methodInfo.bank}\n` +
                `Karta/Hisob raqami: ${paymentDetails}\n\n` +
                `💵 To'lov miqdori: ${totalAmount} ${user.lastSelectedMethod}\n` +
                `📥 Siz olasiz: ${amount} ${user.lastSelectedCurrency}\n` +
                `📊 Xizmat haqqi: ${fee} ${user.lastSelectedCurrency}\n\n` +
                `To'lov qilgach, chek skrinshotini shu yerga yuboring.`;
            
            bot.sendMessage(chatId, paymentMessage);
            
            // Tanlangan valyuta va usulni o'chirish
            await User.findOneAndUpdate(
                { userId },
                { $unset: { lastSelectedCurrency: 1, lastSelectedMethod: 1 } }
            );
        } else if (msg.photo) {
            // Skrinshotni qabul qilish
            const pendingTransaction = await Transaction.findOne({ 
                userId, 
                status: 'pending',
                screenshot: { $exists: false }
            }).sort({ createdAt: -1 });
            
            if (pendingTransaction) {
                const photo = msg.photo[msg.photo.length - 1];
                const fileId = photo.file_id;
                const filePath = await bot.getFile(fileId);
                const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath.file_path}`;
                
                pendingTransaction.screenshot = fileUrl;
                await pendingTransaction.save();
                
                // Foydalanuvchiga tasdiq
                bot.sendMessage(chatId, 'Rahmat! To\'lov skrinshotingiz qabul qilindi. Admin tekshirib, tasdiqlaydi.');
                
                // Adminga xabar
                if (config.adminId) {
                    const adminMessage = await bot.sendPhoto(config.adminId, fileId, {
                        caption: `🔄 Yangi to'lov so'rovi #${pendingTransaction._id}\n\n` +
                            `👤 Foydalanuvchi: @${msg.from.username || 'noma\'lum'} (ID: ${userId})\n` +
                            `💰 Olmoqchi: ${pendingTransaction.amount} ${pendingTransaction.toCurrency}\n` +
                            `💳 To'lov usuli: ${pendingTransaction.paymentMethod}\n` +
                            `🔢 To'lov miqdori: ${pendingTransaction.totalAmount} ${pendingTransaction.fromCurrency}\n` +
                            `📋 Karta/Hisob: ${pendingTransaction.paymentDetails}\n\n` +
                            `⏳ Holat: Kutilmoqda`,
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: '✅ Tasdiqlash', callback_data: `admin_approve_${pendingTransaction._id}` },
                                    { text: '❌ Rad etish', callback_data: `admin_reject_${pendingTransaction._id}` }
                                ]
                            ]
                        }
                    });
                    
                    pendingTransaction.adminMessageId = adminMessage.message_id;
                    await pendingTransaction.save();
                }
            }
        } else if (user.lastSelectedMethod) {
            bot.sendMessage(chatId, 'Iltimos, faqat raqam kiriting yoki menyu orqali qayta boshlang.');
        } else if (text && !text.startsWith('/') && config.adminId) {
            // Admin bilan bog'lanish
            bot.sendMessage(
                config.adminId,
                `✉️ Yangi xabar @${msg.from.username || 'noma\'lum'} (ID: ${userId}):\n\n${text}`
            );
            bot.sendMessage(chatId, 'Xabaringiz adminga yuborildi. Tez orada javob berishadi.');
        }
    } catch (error) {
        console.error('Xabar qayta ishlashda xato:', error);
        bot.sendMessage(chatId, 'Xatolik yuz berdi. Iltimos, qayta urinib ko\'ring.');
    }
});

// 1. Karta raqamini yashirish funksiyasi
function maskCardNumber(number) {
    return number.replace(/\d{4}(?= \d{4})/g, '****');
}

// Admin buyruqlari va funksiyalari
bot.onText(/\/admin/, async (msg) => {
    if (msg.from.id !== config.adminId) return;
    
    const chatId = msg.chat.id;
    
    const adminKeyboard = {
        reply_markup: {
            keyboard: [
                ['🔄 Kutilayotgan tranzaksiyalar', '📋 Barcha tranzaksiyalar'],
                ['👥 Foydalanuvchilar', '📊 Statistika'],
                ['📢 Xabar yuborish', '⚙️ Sozlamalar'],
                ['🖼 Rasmli e\'lon yuborish', '📢 Matnli e\'lon yuborish'],
                ['⬅️ Asosiy menyu']
            ],
            resize_keyboard: true
        }
    };
    
    bot.sendMessage(chatId, '🏛 Admin paneli:', adminKeyboard);
});

// Kutilayotgan tranzaksiyalar
bot.onText(/🔄 Kutilayotgan tranzaksiyalar/, async (msg) => {
    if (msg.from.id !== config.adminId) return;
    
    const chatId = msg.chat.id;
    const pendingTransactions = await Transaction.find({ status: 'pending' })
        .sort({ createdAt: 1 })
        .limit(20);
    
    if (pendingTransactions.length === 0) {
        return bot.sendMessage(chatId, 'ℹ️ Hozircha kutilayotgan tranzaksiyalar mavjud emas.');
    }
    
    bot.sendMessage(chatId, `⏳ Kutilayotgan tranzaksiyalar (${pendingTransactions.length} ta):`);
    
    for (const tx of pendingTransactions) {
        const user = await User.findOne({ userId: tx.userId });
        const username = user?.username ? `@${user.username}` : `ID: ${tx.userId}`;
        
        const message = 
            `📌 Tranzaksiya #${tx._id}\n` +
            `👤 Foydalanuvchi: ${username}\n` +
            `💳 To'lov usuli: ${tx.paymentMethod}\n` +
            `💰 Miqdor: ${tx.amount} ${tx.toCurrency}\n` +
            `📅 Sana: ${tx.createdAt.toLocaleString()}\n` +
            `🔢 Karta: ${tx.paymentDetails || 'Mavjud emas'}`;
        
        const keyboard = {
            inline_keyboard: [
                [
                    { text: '✅ Tasdiqlash', callback_data: `admin_approve_${tx._id}` },
                    { text: '❌ Rad etish', callback_data: `admin_reject_${tx._id}` },
                    { text: 'ℹ️ Batafsil', callback_data: `admin_detail_${tx._id}` }
                ]
            ]
        };
        
        if (tx.screenshot) {
            try {
                await bot.sendPhoto(chatId, tx.screenshot, {
                    caption: message,
                    reply_markup: keyboard
                });
            } catch (e) {
                await bot.sendMessage(chatId, message + '\n\n⚠️ Skrinshot yuklab bo\'lmadi', {
                    reply_markup: keyboard
                });
            }
        } else {
            await bot.sendMessage(chatId, message + '\n\n⚠️ Skrinshot mavjud emas', {
                reply_markup: keyboard
            });
        }
        
        // 1 soniya kutish (flooddan qochish uchun)
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
});

// Barcha tranzaksiyalar
bot.onText(/📋 Barcha tranzaksiyalar/, async (msg) => {
    if (msg.from.id !== config.adminId) return;
    
    const chatId = msg.chat.id;
    
    const statsKeyboard = {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '🔄 Kutilayotgan', callback_data: 'admin_tx_pending' },
                    { text: '✅ Tasdiqlangan', callback_data: 'admin_tx_approved' },
                    { text: '❌ Rad etilgan', callback_data: 'admin_tx_rejected' }
                ],
                [
                    { text: '📅 Bugun', callback_data: 'admin_tx_today' },
                    { text: '📆 Haftalik', callback_data: 'admin_tx_weekly' },
                    { text: '🗓 Oylik', callback_data: 'admin_tx_monthly' }
                ],
                [
                    { text: '🔍 Qidirish', callback_data: 'admin_tx_search' }
                ]
            ]
        }
    };
    
    const count = await Transaction.countDocuments();
    bot.sendMessage(chatId, `📊 Jami tranzaksiyalar: ${count} ta`, statsKeyboard);
});

// Foydalanuvchilar ro'yxati
bot.onText(/👥 Foydalanuvchilar/, async (msg) => {
    if (msg.from.id !== config.adminId) return;
    
    const chatId = msg.chat.id;
    const users = await User.find().sort({ createdAt: -1 }).limit(10);
    
    let message = '👥 So\'ngi 10 foydalanuvchi:\n\n';
    for (const user of users) {
        const txCount = await Transaction.countDocuments({ userId: user.userId });
        message += `👤 ${user.firstName || ''} ${user.lastName || ''} @${user.username || 'noma\'lum'}\n` +
                   `🆔 ${user.userId} | 📅 ${user.createdAt.toLocaleDateString()}\n` +
                   `💳 Tranzaksiyalar: ${txCount} ta\n\n`;
    }
    
    const totalUsers = await User.countDocuments();
    message += `ℹ️ Jami foydalanuvchilar: ${totalUsers} ta`;
    
    bot.sendMessage(chatId, message, {
        reply_markup: {
            inline_keyboard: [
                [{ text: '📊 Barcha foydalanuvchilar', callback_data: 'admin_all_users' }],
                [{ text: '🔍 Foydalanuvchi qidirish', callback_data: 'admin_search_user' }]
            ]
        }
    });
});

// Statistika
bot.onText(/📊 Statistika/, async (msg) => {
    if (msg.from.id !== config.adminId) return;
    
    const chatId = msg.chat.id;
    
    // Bugungi statistika
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);
    
    const todayTx = await Transaction.countDocuments({
        createdAt: { $gte: todayStart, $lte: todayEnd }
    });
    
    const todayApproved = await Transaction.countDocuments({
        status: 'approved',
        createdAt: { $gte: todayStart, $lte: todayEnd }
    });
    
    const todayAmount = await Transaction.aggregate([
        { 
            $match: { 
                status: 'approved',
                createdAt: { $gte: todayStart, $lte: todayEnd }
            } 
        },
        { 
            $group: { 
                _id: null, 
                total: { $sum: "$amount" } 
            } 
        }
    ]);
    
    // Haftalik statistika
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - 7);
    
    const weekTx = await Transaction.countDocuments({
        createdAt: { $gte: weekStart }
    });
    
    const weekApproved = await Transaction.countDocuments({
        status: 'approved',
        createdAt: { $gte: weekStart }
    });
    
    const weekAmount = await Transaction.aggregate([
        { 
            $match: { 
                status: 'approved',
                createdAt: { $gte: weekStart }
            } 
        },
        { 
            $group: { 
                _id: null, 
                total: { $sum: "$amount" } 
            } 
        }
    ]);
    
    const message = 
        `📊 Tranzaksiya statistikasi:\n\n` +
        `📅 Bugun:\n` +
        `- Jami: ${todayTx} ta\n` +
        `- Tasdiqlangan: ${todayApproved} ta\n` +
        `- Summa: ${todayAmount[0]?.total || 0} USD\n\n` +
        `📆 So'ngi 7 kun:\n` +
        `- Jami: ${weekTx} ta\n` +
        `- Tasdiqlangan: ${weekApproved} ta\n` +
        `- Summa: ${weekAmount[0]?.total || 0} USD`;
    
    bot.sendMessage(chatId, message, {
        reply_markup: {
            inline_keyboard: [
                [{ text: '📈 To\'liq statistika', callback_data: 'admin_full_stats' }]
            ]
        }
    });
});

// Xabar yuborish
bot.onText(/📢 Xabar yuborish/, async (msg) => {
    if (msg.from.id !== config.adminId) return;
    
    const chatId = msg.chat.id;
    
    bot.sendMessage(chatId, 'Xabar yuborish uchun quyidagi formatdan foydalaning:\n\n' +
        '📢 Xabar yuborish\n' +
        'Kimga: all/users/123456789\n' +
        'Xabar matni...\n\n' +
        'Misol:\n' +
        '📢 Xabar yuborish\n' +
        'Kimga: all\n' +
        'Yangi yangiliklar! Bot yangilandi!');
});

// Xabar yuborishni qayta ishlash
bot.on('message', async (msg) => {
    if (msg.from.id !== config.adminId) return;
    if (!msg.text || !msg.text.startsWith('📢 Xabar yuborish')) return;
    
    const chatId = msg.chat.id;
    const lines = msg.text.split('\n');
    
    if (lines.length < 3) {
        return bot.sendMessage(chatId, '⚠️ Noto\'g\'ri format. Qayta urinib ko\'ring.');
    }
    
    const target = lines[1].replace('Kimga:', '').trim();
    const messageText = lines.slice(2).join('\n');
    
    try {
        if (target === 'all') {
            const users = await User.find();
            let success = 0, failed = 0;
            
            for (const user of users) {
                try {
                    await bot.sendMessage(user.userId, messageText);
                    success++;
                    await new Promise(resolve => setTimeout(resolve, 500)); // Flooddan qochish
                } catch (e) {
                    failed++;
                }
            }
            
            bot.sendMessage(chatId, `✅ Xabar ${success} ta foydalanuvchiga yuborildi.\n` +
                                   `❌ ${failed} ta foydalanuvchiga yuborib bo'lmadi.`);
        } else if (target === 'users') {
            // Faqat aktiv foydalanuvchilarga
            const weekAgo = new Date();
            weekAgo.setDate(weekAgo.getDate() - 7);
            
            const activeUsers = await User.find({ 
                $or: [
                    { createdAt: { $gte: weekAgo } },
                    { 'transactions.0': { $exists: true } }
                ]
            });
            
            let success = 0, failed = 0;
            
            for (const user of activeUsers) {
                try {
                    await bot.sendMessage(user.userId, messageText);
                    success++;
                    await new Promise(resolve => setTimeout(resolve, 500));
                } catch (e) {
                    failed++;
                }
            }
            
            bot.sendMessage(chatId, `✅ Xabar ${success} ta faol foydalanuvchiga yuborildi.\n` +
                                   `❌ ${failed} ta foydalanuvchiga yuborib bo'lmadi.`);
        } else if (!isNaN(target)) {
            // ID bo'yicha
            try {
                await bot.sendMessage(parseInt(target), messageText);
                bot.sendMessage(chatId, `✅ Xabar foydalanuvchiga yuborildi.`);
            } catch (e) {
                bot.sendMessage(chatId, `❌ Foydalanuvchi topilmadi yoki xabar yuborib bo'lmadi.`);
            }
        } else {
            bot.sendMessage(chatId, '⚠️ Noto\'g\'ri format. "all", "users" yoki foydalanuvchi ID sini kiriting.');
        }
    } catch (e) {
        console.error('Xabar yuborishda xato:', e);
        bot.sendMessage(chatId, '⚠️ Xabar yuborishda xatolik yuz berdi. Qayta urinib ko\'ring.');
    }
});

// Callback query handler for admin actions
bot.on('callback_query', async (callbackQuery) => {
    if (callbackQuery.from.id !== config.adminId) {
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Ruxsat etilmagan!', show_alert: true });
        return;
    }
    
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;
    
    try {
        if (data.startsWith('admin_approve_')) {
            const txId = data.split('_')[2];
            const tx = await Transaction.findById(txId);
            
            if (!tx) {
                return bot.answerCallbackQuery(callbackQuery.id, { 
                    text: 'Tranzaksiya topilmadi!', 
                    show_alert: true 
                });
            }
            
            tx.status = 'approved';
            await tx.save();
            
            // Foydalanuvchi balansini yangilash
            await User.findOneAndUpdate(
                { userId: tx.userId },
                { $inc: { balance: tx.amount } }
            );
            
            // Foydalanuvchiga xabar
            try {
                await bot.sendMessage(tx.userId, 
                    `✅ Sizning ${tx.amount} ${tx.toCurrency} miqdordagi tranzaksiyangiz tasdiqlandi!\n\n` +
                    `Endi sizning balansingiz: ${tx.amount} ${tx.toCurrency}`
                );
            } catch (e) {
                console.error('Foydalanuvchiga xabar yuborishda xato:', e);
            }
            
            // Xabarni yangilash
            const newText = callbackQuery.message.text.replace('⏳ Kutilmoqda', '✅ Tasdiqlangan');
            await bot.editMessageText(newText, {
                chat_id: chatId,
                message_id: callbackQuery.message.message_id,
                reply_markup: { inline_keyboard: [] }
            });
            
            bot.answerCallbackQuery(callbackQuery.id, { text: 'Tranzaksiya tasdiqlandi!' });
            
        } else if (data.startsWith('admin_reject_')) {
            const txId = data.split('_')[2];
            const tx = await Transaction.findById(txId);
            
            if (!tx) {
                return bot.answerCallbackQuery(callbackQuery.id, { 
                    text: 'Tranzaksiya topilmadi!', 
                    show_alert: true 
                });
            }
            
            tx.status = 'rejected';
            await tx.save();
            
            // Foydalanuvchiga xabar
            try {
                await bot.sendMessage(tx.userId, 
                    `❌ Sizning ${tx.amount} ${tx.toCurrency} miqdordagi tranzaksiyangiz rad etildi.\n\n` +
                    `Sabab: To'lov tasdiqlanmadi.\n` +
                    `Agar bu xato deb o'ylasangiz, admin bilan bog'laning.`
                );
            } catch (e) {
                console.error('Foydalanuvchiga xabar yuborishda xato:', e);
            }
            
            // Xabarni yangilash
            const newText = callbackQuery.message.text.replace('⏳ Kutilmoqda', '❌ Rad etilgan');
            await bot.editMessageText(newText, {
                chat_id: chatId,
                message_id: callbackQuery.message.message_id,
                reply_markup: { inline_keyboard: [] }
            });
            
            bot.answerCallbackQuery(callbackQuery.id, { text: 'Tranzaksiya rad etildi!' });
            
        } else if (data.startsWith('admin_detail_')) {
            const txId = data.split('_')[2];
            const tx = await Transaction.findById(txId);
            
            if (!tx) {
                return bot.answerCallbackQuery(callbackQuery.id, { 
                    text: 'Tranzaksiya topilmadi!', 
                    show_alert: true 
                });
            }
            
            const user = await User.findOne({ userId: tx.userId });
            const username = user?.username ? `@${user.username}` : `ID: ${tx.userId}`;
            
            const detailMessage = 
                `📋 Tranzaksiya #${tx._id}\n\n` +
                `👤 Foydalanuvchi: ${username}\n` +
                `📅 Sana: ${tx.createdAt.toLocaleString()}\n\n` +
                `💰 Olmoqchi: ${tx.amount} ${tx.toCurrency}\n` +
                `💳 To'lov usuli: ${tx.paymentMethod}\n` +
                `🔢 To'lashi kerak: ${tx.totalAmount} ${tx.fromCurrency}\n` +
                `📋 Karta/Hisob: ${tx.paymentDetails}\n\n` +
                `📊 Xizmat haqqi: ${tx.fee} ${tx.toCurrency}\n` +
                `🔄 Holat: ${tx.status === 'pending' ? '⏳ Kutilmoqda' : 
                             tx.status === 'approved' ? '✅ Tasdiqlangan' : '❌ Rad etilgan'}`;
            
            bot.answerCallbackQuery(callbackQuery.id);
            
            if (tx.screenshot) {
                try {
                    await bot.sendPhoto(chatId, tx.screenshot, {
                        caption: detailMessage
                    });
                } catch (e) {
                    await bot.sendMessage(chatId, detailMessage + '\n\n⚠️ Skrinshot yuklab bo\'lmadi');
                }
            } else {
                await bot.sendMessage(chatId, detailMessage + '\n\n⚠️ Skrinshot mavjud emas');
            }
        }
        // Boshqa admin callback handlerlari...
    } catch (error) {
        console.error('Admin callbackda xato:', error);
        bot.answerCallbackQuery(callbackQuery.id, { 
            text: 'Xatolik yuz berdi!', 
            show_alert: true 
        });
    }
});

// Admin panelida e'lon yuborish tugmasi
bot.onText(/📢 E'lon yuborish/, async (msg) => {
    if (msg.from.id !== config.adminId) return;
    
    const chatId = msg.chat.id;
    
    const options = {
        reply_markup: {
            keyboard: [
                ['📢 Matnli e\'lon yuborish'],
                ['🖼 Rasmli e\'lon yuborish'],
                ['⬅️ Orqaga']
            ],
            resize_keyboard: true
        }
    };
    
    bot.sendMessage(chatId, 'Qanday turdagi e\'lon yubormoqchisiz?', options);
});

// Matnli e'lon yuborish
bot.onText(/📢 Matnli e'lon yuborish/, async (msg) => {
    if (msg.from.id !== config.adminId) return;
    
    const chatId = msg.chat.id;
    
    // E'lon matnini so'raymiz
    bot.sendMessage(chatId, 'E\'lon matnini yuboring (barcha foydalanuvchilarga yuboriladi):', {
        reply_markup: {
            force_reply: true,
            selective: true
        }
    });
});

// Force replyni qabul qilish
bot.on('reply_to_message', async (msg) => {
    if (msg.from.id !== config.adminId) return;
    if (!msg.reply_to_message.text.includes('E\'lon matnini yuboring')) return;
    
    const chatId = msg.chat.id;
    const messageText = msg.text;
    
    // Foydalanuvchilarni olish
    const users = await User.find();
    const totalUsers = users.length;
    let successCount = 0;
    let failedCount = 0;
    
    // Progress xabarini yuboramiz
    const progressMsg = await bot.sendMessage(chatId, `⏳ E'lon yuborilmoqda...\n0/${totalUsers}`);
    
    // Har bir foydalanuvchiga xabar yuborish
    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        
        try {
            await bot.sendMessage(user.userId, `📢 Yangi e'lon:\n\n${messageText}`);
            successCount++;
            
            // Har 10ta xabardan so'ng progressni yangilash
            if (i % 10 === 0 || i === users.length - 1) {
                await bot.editMessageText(
                    `⏳ E'lon yuborilmoqda...\n${i + 1}/${totalUsers}\n` +
                    `✅ ${successCount} ta muvaffaqiyatli\n` +
                    `❌ ${failedCount} ta muvaffaqiyatsiz`,
                    {
                        chat_id: progressMsg.chat.id,
                        message_id: progressMsg.message_id
                    }
                );
                
                // 500ms kutish (flooddan qochish uchun)
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        } catch (error) {
            failedCount++;
            console.error(`Xabar yuborishda xato (ID: ${user.userId}):`, error);
            
            // Progressni yangilash
            if (i % 10 === 0 || i === users.length - 1) {
                await bot.editMessageText(
                    `⏳ E'lon yuborilmoqda...\n${i + 1}/${totalUsers}\n` +
                    `✅ ${successCount} ta muvaffaqiyatli\n` +
                    `❌ ${failedCount} ta muvaffaqiyatsiz`,
                    {
                        chat_id: progressMsg.chat.id,
                        message_id: progressMsg.message_id
                    }
                );
            }
        }
    }
    
    // Yakuniy xabar
    await bot.editMessageText(
        `📊 E'lon yuborish yakunlandi!\n\n` +
        `👥 Jami foydalanuvchilar: ${totalUsers} ta\n` +
        `✅ Muvaffaqiyatli: ${successCount} ta\n` +
        `❌ Muvaffaqiyatsiz: ${failedCount} ta\n\n` +
        `Muvaffaqiyatsiz yuborilgan foydalanuvchilar botni bloklagan yoki start bermagan bo'lishi mumkin.`,
        {
            chat_id: progressMsg.chat.id,
            message_id: progressMsg.message_id
        }
    );
});

// Rasmli e'lon yuborish
bot.onText(/🖼 Rasmli e'lon yuborish/, async (msg) => {
    if (msg.from.id !== config.adminId) return;
    
    const chatId = msg.chat.id;
    
    bot.sendMessage(chatId, 'E\'lon uchun rasm yuboring:', {
        reply_markup: {
            force_reply: true,
            selective: true
        }
    });
});

// Rasmni qabul qilish
bot.on('photo', async (msg) => {
    if (msg.from.id !== config.adminId) return;
    if (!msg.reply_to_message || !msg.reply_to_message.text.includes('E\'lon uchun rasm yuboring')) return;
    
    const chatId = msg.chat.id;
    const photoId = msg.photo[msg.photo.length - 1].file_id;
    
    // Rasmni saqlab qo'yamiz
    adminState.announcementPhoto = photoId;
    
    // Endi matnni so'raymiz
    bot.sendMessage(chatId, 'Endi e\'lon matnini yuboring (rasm bilan birga yuboriladi):', {
        reply_markup: {
            force_reply: true,
            selective: true
        }
    });
});

// Rasmli e'lon matnini qabul qilish
bot.on('reply_to_message', async (msg) => {
    if (msg.from.id !== config.adminId) return;
    if (!msg.reply_to_message.text.includes('e\'lon matnini yuboring')) return;
    if (!adminState.announcementPhoto) return;
    
    const chatId = msg.chat.id;
    const messageText = msg.text;
    const photoId = adminState.announcementPhoto;
    
    // Foydalanuvchilarni olish
    const users = await User.find();
    const totalUsers = users.length;
    let successCount = 0;
    let failedCount = 0;
    
    // Progress xabarini yuboramiz
    const progressMsg = await bot.sendMessage(chatId, `⏳ Rasmli e'lon yuborilmoqda...\n0/${totalUsers}`);
    
    // Har bir foydalanuvchiga xabar yuborish
    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        
        try {
            await bot.sendPhoto(user.userId, photoId, { caption: `📢 Yangi e'lon:\n\n${messageText}` });
            successCount++;
            
            // Har 10ta xabardan so'ng progressni yangilash
            if (i % 10 === 0 || i === users.length - 1) {
                await bot.editMessageText(
                    `⏳ Rasmli e'lon yuborilmoqda...\n${i + 1}/${totalUsers}\n` +
                    `✅ ${successCount} ta muvaffaqiyatli\n` +
                    `❌ ${failedCount} ta muvaffaqiyatsiz`,
                    {
                        chat_id: progressMsg.chat.id,
                        message_id: progressMsg.message_id
                    }
                );
                
                // 500ms kutish (flooddan qochish uchun)
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        } catch (error) {
            failedCount++;
            console.error(`Rasmli xabar yuborishda xato (ID: ${user.userId}):`, error);
            
            // Progressni yangilash
            if (i % 10 === 0 || i === users.length - 1) {
                await bot.editMessageText(
                    `⏳ Rasmli e'lon yuborilmoqda...\n${i + 1}/${totalUsers}\n` +
                    `✅ ${successCount} ta muvaffaqiyatli\n` +
                    `❌ ${failedCount} ta muvaffaqiyatsiz`,
                    {
                        chat_id: progressMsg.chat.id,
                        message_id: progressMsg.message_id
                    }
                );
            }
        }
    }
    
    // Yakuniy xabar
    await bot.editMessageText(
        `📊 Rasmli e'lon yuborish yakunlandi!\n\n` +
        `👥 Jami foydalanuvchilar: ${totalUsers} ta\n` +
        `✅ Muvaffaqiyatli: ${successCount} ta\n` +
        `❌ Muvaffaqiyatsiz: ${failedCount} ta\n\n` +
        `Muvaffaqiyatsiz yuborilgan foydalanuvchilar botni bloklagan yoki start bermagan bo'lishi mumkin.`,
        {
            chat_id: progressMsg.chat.id,
            message_id: progressMsg.message_id
        }
    );
    
    // Rasmni tozalash
    adminState.announcementPhoto = null;
});

// Botni ishga tushirish
console.log('Bot ishga tushdi...');

// Xatoliklarni qayta ishlash
bot.on('polling_error', (error) => {
    console.error('Polling xatosi:', error);
});

process.on('unhandledRejection', (error) => {
    console.error('Qayta ishlanmagan rad etish:', error);
});
