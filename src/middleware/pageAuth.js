const jwt = require('jsonwebtoken')

function pageAuthMiddleware(req, res, next) {
  const token = req.cookies?.token ||
                req.query?.token

  if (!token) {
    return res.redirect('/login.html')
  }

  try {
    jwt.verify(token, process.env.JWT_SECRET)
    next()
  } catch {
    res.clearCookie('token')
    return res.redirect('/login.html')
  }
}

module.exports = pageAuthMiddleware
