'use strict';
// Vercel serverless entry: every /api/* request is rewritten here (see vercel.json).
const { handler } = require('../server/app');

module.exports = handler;
