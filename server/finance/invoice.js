// SBOS-A1-ERP invoice CRUD + status lifecycle — RED stub.
//
// This is the TDD RED branch. Every export throws NotImplementedError so the
// test suite fails fast and visibly. The GREEN implementation lands in
// commit B (see plan30/wave5-invoice branch history).
//
// Public API (locked by the spec — see commit B for full implementation):
//   createInvoice(db, input)          → full invoice row + lines
//   getInvoice(db, id)                → invoice row + lines, or null
//   listInvoices(db, filters)         → array of invoice rows
//   updateInvoice(db, id, patch)      → updated invoice row + lines
//   voidInvoice(db, id, reason)       → updated invoice row with void_reason

class NotImplementedError extends Error {
  constructor(name) {
    super(`invoice.js RED stub: ${name} not implemented yet`);
    this.name = 'NotImplementedError';
  }
}

export async function createInvoice(/* db, input */) {
  throw new NotImplementedError('createInvoice');
}
export async function getInvoice(/* db, id */) {
  throw new NotImplementedError('getInvoice');
}
export async function listInvoices(/* db, filters */) {
  throw new NotImplementedError('listInvoices');
}
export async function updateInvoice(/* db, id, patch */) {
  throw new NotImplementedError('updateInvoice');
}
export async function voidInvoice(/* db, id, reason */) {
  throw new NotImplementedError('voidInvoice');
}