export function adminOnly(isAdmin) {
  return (req, res, next) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
    next();
  };
}
