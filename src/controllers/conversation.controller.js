const Conversation = require("../models/Conversation");
const ConversationUser = require("../models/ConversationUser");

exports.getOrCreateConversation = async (req, res) => {

  try {

    const userId = req.user.id;

    const existed = await ConversationUser.findOne({
      idUser: userId,
      roleInConversation: "USER"
    }).populate("idConversation");

    if (existed) {
      return res.json(existed.idConversation);
    }

    const conversation = await Conversation.create({});

    await ConversationUser.create({
      idConversation: conversation._id,
      idUser: userId,
      roleInConversation: "USER"
    });

    // Current DB admins are authorized by role; no hardcoded admin account ID.

    res.json(conversation);

  } catch (err) {

    res.status(500).json({ message: err.message });

  }

};

exports.getAllConversations = async (req, res) => {

  try {

    const conversations = await ConversationUser.find({
      roleInConversation: "USER"
    })
      .populate("idConversation")
      .populate("idUser", "name");

    res.json(conversations);

  } catch (err) {

    res.status(500).json({ message: err.message });

  }

};
