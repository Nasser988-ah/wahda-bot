function validate(schema) {
  return (req, res, next) => {
    const { error } = schema(req.body);
    if (error) {
      return res.status(422).json({
        error: "Validation failed",
        details: error,
      });
    }
    next();
  };
}

function shopSchema(data) {
  const errors = [];
  if (!data.name || typeof data.name !== "string") {
    errors.push("name is required and must be a string");
  }
  if (!data.phone || typeof data.phone !== "string") {
    errors.push("phone is required and must be a string");
  }
  return errors.length ? { error: errors } : {};
}

module.exports = { validate, shopSchema };
