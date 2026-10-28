function notFound(req, res, next) {
  res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  console.error(err);

  if (err.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({ success: false, message: 'A record with these unique details already exists.' });
  }
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ success: false, message: 'Uploaded file is too large.' });
  }
  // Hide raw MySQL foreign-key messages from the UI.
  if (err.code === 'ER_NO_REFERENCED_ROW_2' || err.code === 'ER_NO_REFERENCED_ROW') {
    return res.status(409).json({
      success: false,
      code: 'STALE_REFERENCE',
      message: 'One of the records this refers to (e.g. your account) no longer exists. Please sign out and sign in again.'
    });
  }
  if (err.code === 'ER_ROW_IS_REFERENCED_2' || err.code === 'ER_ROW_IS_REFERENCED') {
    return res.status(409).json({
      success: false,
      message: 'This record is still referenced by other data and cannot be deleted.'
    });
  }

  const status = err.status || 500;
  res.status(status).json({
    success: false,
    message: err.message || 'An unexpected server error occurred.'
  });
}

module.exports = { notFound, errorHandler };