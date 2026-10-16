const Order=require("../models/Order");
const OrderItem=require("../models/OrderItem");
const transitionOrder = require("../services/orderTransition.service");
const { allowedAdminTransitions, canUserCancel } = require("../utils/orderState");

const checkout = require("../services/checkout.service");

// Checkout creates the initial state; later writes use the transition service.
async function createOrder(req, res) {
  try {
    const result = await checkout(req.user._id, req.body, { paymentMethods: req.app.locals.paymentMethods });
    res.status(result.replayed ? 200 : 201).json({
      message: result.replayed ? "Order already created" : "Order created",
      ...result
    });
  } catch (error) {
    res.status(error.status || 500).json({
      code: error.status ? error.code : "CHECKOUT_FAILED",
      ...(error.itemId ? { itemId: error.itemId } : {}),
      message: error.status ? error.message : "Checkout failed. Please retry the same request."
    });
  }
}

//Get my order
async function getMyOrders(req,res){
try{

const orders = await Order.find({
  idUser: req.user._id
})
.sort({createdAt:-1})
.lean();

for(const order of orders){

  const items = await OrderItem.find({
    idOrder: order._id
  })
  .populate({
    path:"idProductVariant",
    populate:{
      path:"idProduct"
    }
  });

  order.items = items;
  order.canCancel = canUserCancel(order);

}

res.json(orders);

}catch(error){
res.status(500).json({message:error.message});
}
};

async function updateOrderStatus(req, res) {
  try {
    const result = await transitionOrder({
      orderId: req.params.id, status: req.body.status,
      actor: { type: "ADMIN", id: req.user._id }
    });
    res.json({ message: "Cập nhật trạng thái thành công", ...result });
  } catch (error) {
    sendTransitionError(res, error);
  }
}

async function cancelOrder(req, res) {
  try {
    const result = await transitionOrder({
      orderId: req.params.id, status: "CANCEL",
      actor: { type: "USER", id: req.user._id }
    });
    res.json({ message: "Đã hủy đơn hàng", ...result });
  } catch (error) {
    sendTransitionError(res, error);
  }
}

function sendTransitionError(res, error) {
  res.status(error.status || 500).json({
    code: error.status ? error.code : "ORDER_UPDATE_FAILED",
    message: error.status ? error.message : "Không thể cập nhật đơn hàng. Vui lòng thử lại"
  });
}

async function getAllOrders(req,res){
try{

const orders=await Order.find()
.sort({createdAt:-1})
.populate("idUser","name email")
.lean();

for(const order of orders){

const items=await OrderItem.find({
idOrder:order._id
})
.populate({
path:"idProductVariant",
populate:{
path:"idProduct"
}
});

order.items=items;
order.allowedTransitions = allowedAdminTransitions(order);

}

res.json(orders);

}catch(error){
res.status(500).json({message:error.message});
}
}
module.exports={createOrder,getMyOrders,updateOrderStatus,cancelOrder,getAllOrders};
