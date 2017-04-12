const mongoose = require('mongoose');
const Address = require('./Address');
const PaymentMethod = require('./PaymentMethod');
const Subscription = require('./Subscription');
const Transaction = require('./Transaction');
const ProcessorItem = require('./ProcessorItem');
const SubscriptionStatus = require('./Statuses/SubscriptionStatus');
const DiscountPreviousSubscription = require('./Discount/PreviousSubscription');

const Schema = mongoose.Schema;

const Customer = new Schema({
    processor: {
        type: ProcessorItem,
        default: ProcessorItem,
    },
    ipAddress: String,
    name: {
        type: String,
        required: true,
        trim: true,
    },
    email: {
        type: String,
        required: true,
        lowercase: true,
        trim: true,
        match: /^([\w-.+]+@([\w-]+\.)+[\w-]{2,6})?$/,
    },
    phone: String,
    addresses: [Address],
    paymentMethods: [PaymentMethod],
    defaultPaymentMethodId: String,
    subscriptions: [Subscription],
    transactions: [Transaction],
});

const paymentMethods = Customer.path('paymentMethods');
const transactions = Customer.path('transactions');

paymentMethods.discriminator('CreditCard', PaymentMethod.CreditCard);
paymentMethods.discriminator('PayPalAccount', PaymentMethod.PayPalAccount);
paymentMethods.discriminator('ApplePayCard', PaymentMethod.ApplePayCard);
paymentMethods.discriminator('AndroidPayCard', PaymentMethod.AndroidPayCard);

transactions.discriminator('TransactionCreditCard', Transaction.TransactionCreditCard);
transactions.discriminator('TransactionPayPalAccount', Transaction.TransactionPayPalAccount);
transactions.discriminator('TransactionApplePayCard', Transaction.TransactionApplePayCard);
transactions.discriminator('TransactionAndroidPayCard', Transaction.TransactionAndroidPayCard);

function markChanged() {
    if (this.processor.id && this.isModified('name email phone ipAddress defaultPaymentMethodId')) {
        this.processor.state = ProcessorItem.CHANGED;
    }

    ['addresses', 'subscriptions', 'paymentMethods'].forEach((collectionName) => {
        this[collectionName].forEach((item, index) => {
            if (item.processor.id && this.isModified(`${collectionName}.${index}`)) {
                item.processor.state = ProcessorItem.CHANGED;
            }
        });
    });

    return this;
}

function cancelProcessor(processor, id) {
    return processor.cancelSubscription(this, id).then(customer => customer.save());
}

function refundProcessor(processor, id, amount) {
    return processor.refundTransaction(this, id, amount).then(customer => customer.save());
}

function loadProcessor(processor) {
    return processor.load(this).then(customer => customer.save());
}

function saveProcessor(processor) {
    this.markChanged();
    return processor.save(this).then(customer => customer.save());
}

function cancelSubscriptions() {
    const cancaleableStatuses = [
        SubscriptionStatus.PENDING,
        SubscriptionStatus.PAST_DUE,
        SubscriptionStatus.ACTIVE,
    ];

    this.subscriptions
        .filter(sub => cancaleableStatuses.includes(sub.status))
        .forEach(sub => sub.status = SubscriptionStatus.CANCELED);

    return this;
}

function addAddress(addressData) {
    const address = this.addresses.create(addressData);
    this.addresses.push(address);

    return address;
}

function defaultPaymentMethod() {
    return this.paymentMethods.id(this.defaultPaymentMethodId);
}

function addPaymentMethodNonce(nonce, address) {
    const paymentMethod = this.paymentMethods.create({
        billingAddressId: address._id,
        nonce,
    });

    this.paymentMethods.push(paymentMethod);
    this.defaultPaymentMethodId = paymentMethod._id;

    return paymentMethod;
}

function addSubscription(plan, paymentMethod, activeDate) {
    const date = activeDate || new Date();

    const waitForSubs = this.validSubscriptions(date)
        .filter(item => !item.isTrial)
        .filter(item => item.plan.level >= plan.level)
        .sort((a, b) => a.paidThroughDate < b.paidThroughDate);

    const refundableSubs = this.validSubscriptions(date)
        .filter(item => !item.isTrial)
        .filter(item => item.plan.level < plan.level)
        .filter(item => item.processor.state !== ProcessorItem.LOCAL);

    const sub = this.subscriptions
        .create({
            plan,
            paymentMethodId: paymentMethod._id,
            firstBillingDate: waitForSubs.length ? waitForSubs[0].paidThroughDate : date,
            price: plan.price,
        })
        .addDiscounts(newSub => {
            return [DiscountPreviousSubscription.build(newSub, refundableSubs[0])];
        });

    this.subscriptions.push(sub);

    return sub;
}

function activeSubscriptions(activeDate) {
    return this.validSubscriptions(activeDate)
        .filter(item => item.status === SubscriptionStatus.ACTIVE);
}

function validSubscriptions(activeDate) {
    const date = activeDate || new Date();

    return this.subscriptions
        .filter(item => item.firstBillingDate < date)
        .filter(item => item.paidThroughDate >= date)
        .sort((a, b) => b.plan.level - a.plan.level);
}

function subscription(activeDate) {
    return this.validSubscriptions(activeDate)[0];
}

Customer.method('markChanged', markChanged);
Customer.method('cancelProcessor', cancelProcessor);
Customer.method('refundProcessor', refundProcessor);
Customer.method('loadProcessor', loadProcessor);
Customer.method('saveProcessor', saveProcessor);
Customer.method('cancelSubscriptions', cancelSubscriptions);
Customer.method('addAddress', addAddress);
Customer.method('defaultPaymentMethod', defaultPaymentMethod);
Customer.method('addPaymentMethodNonce', addPaymentMethodNonce);
Customer.method('addSubscription', addSubscription);
Customer.method('activeSubscriptions', activeSubscriptions);
Customer.method('validSubscriptions', validSubscriptions);
Customer.method('subscription', subscription);

module.exports = Customer;
