// Versionless tokens must log in again when this release is deployed.
module.exports = function validSession(decoded, user) {
  return Boolean(user && Number.isSafeInteger(decoded.authVersion) && decoded.authVersion >= 0 &&
    decoded.authVersion === (user.authVersion ?? 0));
};
