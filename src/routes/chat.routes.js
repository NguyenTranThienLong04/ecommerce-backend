const router = require("express").Router();

const conversationController = require("../controllers/conversation.controller");
const messageController = require("../controllers/message.controller");

const auth = require("../middlewares/auth.middleware");
const admin = require("../middlewares/admin.middleware");

router.post(
  "/conversation",
  auth,
  conversationController.getOrCreateConversation
);

router.post(
  "/message",
  auth,
  messageController.sendMessage
);

router.get(
  "/messages/:conversationId",
  auth,
  messageController.getMessages
);

router.get(
  "/admin/conversations",
  auth,
  admin,
  conversationController.getAllConversations
);

router.put(
  "/read/:conversationId",
  auth,
  messageController.markAsRead
);

module.exports = router;
