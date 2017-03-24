const mongoose = require('mongoose');
const ProcessorItem = require('../ProcessorItem');

const Schema = mongoose.Schema;

/**
 * Coupon Discount
 */
const DiscountCoupon = new Schema({
    coupon: {
        type: Schema.Types.ObjectId,
        ref: 'Coupon',
        required: true,
    },
}, { _id: false });

DiscountCoupon.build = function build(subscription, coupon, currentDate) {
    const amount = coupon.currentAmount(subscription);
    const today = currentDate || new Date();

    if (coupon.usedCount >= coupon.usedCountMax) {
        return null;
    }

    if (coupon.startAt && coupon.startAt < today) {
        return null;
    }

    if (coupon.expireAt && coupon.expireAt < today) {
        return null;
    }

    if (!amount) {
        return null;
    }

    return {
        coupon,
        amount: amount.toFixed(2),
        __t: 'DiscountCoupon',
        name: coupon.name,
    };
};

DiscountCoupon.pre('save', function preSave(next) {
    if (
        this.original
        && this.coupon
        && this.original.processor.state === ProcessorItem.INITIAL
        && this.processor.state === ProcessorItem.SAVED
    ) {
        const coupon = this.coupon;
        coupon.usedCount += 1;
        coupon.save(next);
    } else {
        next();
    }
});

module.exports = DiscountCoupon;
