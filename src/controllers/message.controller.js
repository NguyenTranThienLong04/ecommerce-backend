const Message = require("../models/Message");
const sendMessage = require("../services/message.service");
const { authorizeConversation } = require("../utils/chatAuthorization");

exports.sendMessage = async (req, res) => {

  try {

    const io = req.app.get("io");

    const { message } = await sendMessage(req.user, req.body, io);
    res.json(message);

  } catch (err) {

    res.status(err.status || 500).json({ message: err.status ? err.message : "Lỗi xử lý chat" });

  }

};

exports.getMessages = async (req, res) => {

  try {

    const conversationId = await authorizeConversation(req.user, req.params.conversationId);

    const messages = await Message.find({
      idConversation: conversationId
    })
      .populate("idUser", "name")
      .sort({ createdAt: 1 });

    res.json(messages);

  } catch (err) {

    res.status(err.status || 500).json({ message: err.status ? err.message : "Lỗi xử lý chat" });

  }

};

exports.markAsRead = async (req, res) => {

  try {

    const conversationId = await authorizeConversation(req.user, req.params.conversationId);

    await Message.updateMany(
      {
        idConversation: conversationId,
        isRead: false,
        idUser: { $ne: req.user._id }
      },
      {
        isRead: true
      }
    );

    res.json({ message: "Messages marked as read" });

  } catch (err) {

    res.status(err.status || 500).json({ message: err.status ? err.message : "Lỗi xử lý chat" });

  }

};
