const mongoose = require("mongoose");
const Address = require("./Address");
const PaymentMethod = require("./PaymentMethod");
const Subscription = require("./Subscription");
const Transaction = require("./Transaction");
const ProcessorItem = require("./ProcessorItem");
const SubscriptionStatus = require("./Statuses/SubscriptionStatus");
const DiscountPreviousSubscription = require("./Discount/PreviousSubscription");
const originals = require("mongoose-originals");

const Customer = new mongoose.Schema({
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

const paymentMethods = Customer.path("paymentMethods");
const transactions = Customer.path("transactions");

paymentMethods.discriminator("CreditCard", PaymentMethod.CreditCard);
paymentMethods.discriminator("PayPalAccount", PaymentMethod.PayPalAccount);
paymentMethods.discriminator("ApplePayCard", PaymentMethod.ApplePayCard);
paymentMethods.discriminator("AndroidPayCard", PaymentMethod.AndroidPayCard);

transactions.discriminator("TransactionCreditCard", Transaction.TransactionCreditCard);
transactions.discriminator("TransactionPayPalAccount", Transaction.TransactionPayPalAccount);
transactions.discriminator("TransactionApplePayCard", Transaction.TransactionApplePayCard);
transactions.discriminator("TransactionAndroidPayCard", Transaction.TransactionAndroidPayCard);

function markChanged() {
    if (this.processor.id && this.isModified("name email phone ipAddress defaultPaymentMethodId")) {
        this.processor.state = ProcessorItem.CHANGED;
    }

    ["addresses", "subscriptions", "paymentMethods"].forEach(collectionName => {
        this[collectionName].forEach((item, index) => {
            if (
                item.processor.id &&
                this.isModified(`${collectionName}.${index}`) &&
                item.isChanged()
            ) {
                item.processor.state = ProcessorItem.CHANGED;
            }
        });
    });

    return this;
}

function cancelProcessor(processor, subscriptionId) {
    this.setSnapshotOriginal();
    return processor.cancelSubscription(this, subscriptionId).then(customer => {
        customer.clearSnapshotOriginal();
        return customer.save();
    });
}

function refundProcessor(processor, transactionId, amount) {
    this.setSnapshotOriginal();
    return processor.refundTransaction(this, transactionId, amount).then(customer => {
        customer.clearSnapshotOriginal();
        return customer.save();
    });
}

function loadProcessor(processor) {
    if (!this.processor.id) {
        return this.save();
    }
    return processor.load(this).then(customer => customer.removeInitial().save());
}

function saveProcessor(processor) {
    this.setSnapshotOriginal();
    this.markChanged();
    return processor.save(this).then(customer => {
        customer.clearSnapshotOriginal();
        return customer.save();
    });
}

function cancelSubscriptions() {
    const cancaleableStatuses = [
        SubscriptionStatus.PENDING,
        SubscriptionStatus.PAST_DUE,
        SubscriptionStatus.ACTIVE,
    ];

    this.subscriptions.filter(sub => cancaleableStatuses.includes(sub.status)).forEach(sub => {
        sub.status = SubscriptionStatus.CANCELED;
    });

    return this;
}

function removeInitial() {
    ["addresses", "paymentMethods", "subscriptions"].forEach(name => {
        this[name] = this[name].filter(item => item.processor.state !== ProcessorItem.INITIAL);
    });

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

function getUnusedAddress() {
    return this.addresses.find(address => {
        return !this.paymentMethods.find(
            paymentMethod => paymentMethod.billingAddressId === address.id
        );
    });
}

function setDefaultPaymentMethod(paymentMethodData, addressData) {
    const current = this.defaultPaymentMethod();
    const currentAddress = (current && current.billingAddress()) || this.getUnusedAddress();
    let paymentMethod;

    if (current && paymentMethodData.__t === current.__t) {
        paymentMethod = Object.assign(current, paymentMethodData);
    } else {
        paymentMethod = this.paymentMethods.create(paymentMethodData);
        this.paymentMethods.push(paymentMethod);
    }

    if (addressData) {
        let address;

        if (currentAddress) {
            address = Object.assign(currentAddress, addressData);
        } else {
            address = this.addresses.create(addressData);
            this.addresses.push(address);
        }

        if (address._id) {
            paymentMethod.billingAddressId = address._id;
        }
    }

    this.defaultPaymentMethodId = paymentMethod;

    return paymentMethod;
}

function addPaymentMethodNonce(nonce, address) {
    const paymentMethod = this.paymentMethods.create({
        nonce: nonce,
    });

    if (address) {
        paymentMethod.billingAddressId = address._id;
    }

    this.paymentMethods.push(paymentMethod);
    this.defaultPaymentMethodId = paymentMethod._id;

    return paymentMethod;
}

function addSubscription(plan, paymentMethod, activeDate) {
    const date = activeDate || new Date();
    const nonTrialSubs = this.validSubscriptions(date).filter(item => !item.isTrial);

    const waitForSubs = nonTrialSubs
        .filter(item => item.plan.level >= plan.level)
        .sort((a, b) => a.paidThroughDate < b.paidThroughDate);

    const refundableSubs = nonTrialSubs
        .filter(item => item.plan.level < plan.level)
        .filter(item => item.processor.state !== ProcessorItem.LOCAL);

    const subscription = this.subscriptions
        .create({
            plan,
            firstBillingDate: waitForSubs.length ? waitForSubs[0].paidThroughDate : null,
            price: plan.price,
        })
        .addDiscounts(newSub => [
            DiscountPreviousSubscription.build(newSub, refundableSubs[0], activeDate),
        ]);

    if (paymentMethod) {
        subscription.paymentMethodId = paymentMethod._id;
    }

    this.subscriptions.push(subscription);

    return subscription;
}

function activeSubscriptions(activeDate) {
    return this.validSubscriptions(activeDate)
        .filter(item => !item.deleted)
        .filter(item => item.status === SubscriptionStatus.ACTIVE);
}

function validSubscriptions(activeDate) {
    const date = activeDate || new Date();

    return this.subscriptions
        .filter(item => !item.deleted)
        .filter(item => item.firstBillingDate < date)
        .filter(item => item.paidThroughDate >= date)
        .filter(item => item.hasActiveStatus)
        .sort((a, b) => {
            return b.plan.level === a.plan.level
                ? b.paidThroughDate.getTime() - a.paidThroughDate.getTime()
                : b.plan.level - a.plan.level;
        });
}

function subscription(activeDate) {
    return this.validSubscriptions(activeDate)[0];
}

Customer.plugin(originals, {
    fields: ["ipAddress", "name", "email", "phone", "defaultPaymentMethodId"],
});

Customer.method("getUnusedAddress", getUnusedAddress);
Customer.method("markChanged", markChanged);
Customer.method("removeInitial", removeInitial);
Customer.method("cancelProcessor", cancelProcessor);
Customer.method("refundProcessor", refundProcessor);
Customer.method("loadProcessor", loadProcessor);
Customer.method("saveProcessor", saveProcessor);
Customer.method("cancelSubscriptions", cancelSubscriptions);
Customer.method("addAddress", addAddress);
Customer.method("defaultPaymentMethod", defaultPaymentMethod);
Customer.method("addPaymentMethodNonce", addPaymentMethodNonce);
Customer.method("setDefaultPaymentMethod", setDefaultPaymentMethod);
Customer.method("addSubscription", addSubscription);
Customer.method("activeSubscriptions", activeSubscriptions);
Customer.method("validSubscriptions", validSubscriptions);
Customer.method("subscription", subscription);

module.exports = Customer;
