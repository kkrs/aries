// ARIES: Algorithm for Recovery and Isolation Exploiting Semantics [1, 2].
//
// Relational databases support transactions with guarantees of atomicity,
// consistency, isolation, and durability. Consistency is provided (partially)
// by keys, constraints, and triggers. Isolation is provided by some form
// concurrency control like two-phase locking. Atomicity and durability are the
// responsibility of a database' recovery procedure. The recovery procedure is
// responsible for ensuring that committed data is persisted and dually for
// ensuring that non-committed data is not persisted. It must provide these
// guarantees even in the event of repeated failures.
//
// ARIES is an industry strength recovery procedure developed at IBM. It
// employs write-ahead logging, a bunch of data structures, and a three phase
// algorithm. At any given point of execution, the state of ARIES may look
// something like this:
//
// Dirty Page Table                Log
// +--------+--------+             +-----+---------+--------+--------+---------+
// | pageID | recLSN |             | LSN | transID | type   | pageID | prevLSN |
// +--------+--------+             +-----+---------+--------+--------+---------+
// | A      | 0      |             | 0   | T1      | update | A      | null    |
// | B      | 9      |             | 1   | T2      | update | B      | null    |
// | C      | 7      |             | 2   | T3      | update | C      | null    |
// +--------+--------+             | 3   | T2      | update | D      | 1       |
//                                 | 4   | T1      | update | A      | 0       |
// Transaction Table               | 5   | T1      | commit |        | 4       |
// +---------+--------+---------+  | 6   | T1      | end    |        | 5       |
// | transID | status | lastLSN |  | 7   | T3      | update | C      | 2       |
// +---------+--------+---------+  | 8   | T2      | update | D      | 3       |
// | T2      | run    | 9       |  | 9   | T2      | update | B      | 8       |
// | T3      | run    | 10      |  | 10  | T3      | update | A      | 7       |
// +---------+--------+---------+  +-----+---------+--------+--------+---------+
//
// Buffer Pool                     Disk
// +--------+---------+-------+    +--------+---------+-------+
// | pageID | pageLSN | value |    | pageID | pageLSN | value |
// +--------+---------+-------+    +--------+---------+-------+
// | A      | 10      | "foo" |    | A      |         | ""    |
// | B      | 9       | "bar" |    | B      | 1       | "jar" |
// | C      | 7       | "baz" |    | C      | 2       | "yaz" |
// +--------+---------+-------+    | D      | 8       | "moo" |
//                                 +--------+---------+-------+
//
// This file implements a simplified version of the ARIES recovery procedure
// and is meant to help others learn the basics of how ARIES works.
//
// [1]: https://goo.gl/WsauYU
// [2]: http://pages.cs.wisc.edu/~dbbook/
//
// TODO(mwhittaker): Make functions check that none of their inputs are
// undefined.
// TODO(larry): Add visualization.

// The aries global namespace.
var aries = {};

// Types ///////////////////////////////////////////////////////////////////////
// Operations.
//
// ARIES processes a sequence of writes, commits, checkpoints, and page flushes
// from a number of transactions. For example, ARIES may process the following
// sequence of operations:
//
//   - W_1(A, "foo") // Transaction 1 writes value "foo" to page A.
//   - W_2(B, "bar") // Transaction 2 writes value "bar" to page B.
//   - Commit_1()    // Transaction 1 commits.
//   - Flush(B)      // Page B is flushed to disk.
//
// Note that there is an operation for writes but not for reads. Since reads do
// not mutate the state of the database, they can be ignored by ARIES.
// Operations are represented by the following types:
//
//   type Op.Type =
//     | WRITE
//     | COMMIT
//     | FLUSH
//     | CHECKPOINT
//
//   type Op.Operation = {
//     type:    aries.Op.Type,
//     txn_id:  string,
//     page_id: string,
//     value:   string
//   }
//
//   | type       | txn_id | page_id | value |
//   | ---------- | ------ | ------- | ----- |
//   | write      | y      | y       | y     |
//   | commit     | y      | n       | n     |
//   | flush      | n      | y       | n     |
//   | checkpoint | n      | n       | n     |
//
// For example, the sequence of operations above would be represented as:
//
//   - {type: WRITE,  txn_id:"1", page_id:"A", value:"foo"}
//   - {type: WRITE,  txn_id:"2", page_id:"B", value:"bar"}
//   - {type: COMMIT, txn_id:"1"                          }
//   - {type: FLUSH,              page_id:"B"             }
aries.Op = {};

aries.Op.Type = {
  WRITE:      "write",
  COMMIT:     "commit",
  FLUSH:      "flush",
  CHECKPOINT: "checkpoint",
};

aries.Op.Operation = function(type) {
  this.type = type;
}

aries.Op.Write = function(txn_id, page_id, value) {
  aries.Op.Operation.call(this, aries.Op.Type.WRITE);
  this.txn_id = txn_id;
  this.page_id = page_id;
  this.value = value;
}

aries.Op.Commit = function(txn_id) {
  aries.Op.Operation.call(this, aries.Op.Type.COMMIT);
  this.txn_id = txn_id;
}

aries.Op.Flush = function(page_id) {
  aries.Op.Operation.call(this, aries.Op.Type.FLUSH);
  this.page_id = page_id;
}

aries.Op.Checkpoint = function() {
  aries.Op.Operation.call(this, aries.Op.Type.CHECKPOINT);
}

// `aries.Op.explain(op: aries.Op.Operation) -> string` returns an English
// description of the operation. For example, `aries.Op.explain({type: WRITE,
// txn_id:"1", page_id:"A", value:"foo"})` might return "Transaction 1 wrote
// "foo" to page A".
aries.Op.explain = function(op) {
  if (op.type === aries.Op.Type.WRITE) {
    return "Transaction " + op.txn_id + " wrote '" + op.value + "' to page " +
      op.page_id + ".";
  } else if (op.type === aries.Op.Type.COMMIT) {
    return "Transaction " + op.txn_id + " committed."
  } else if (op.type === aries.Op.Type.CHECKPOINT) {
    return "ARIES checkpointed.";
  } else if (op.type === aries.Op.Type.FLUSH) {
    return "Page " + op.page_id + " was flushed.";
  } else {
    console.assert(false, "Invalid operation type: " + op.type +
                   " in operation " + op);
  }
}

// `aries.Op.parse_op(s: string) -> Parsimmon parser` returns a parser that can
// parse an operation from a string using the following grammar.
//
//   alpha     ::= ([a-z] | [A-Z])
//   num       ::= [0-9]
//   alphanums ::= (alpha | num)+
//   txn_id    ::= alphanums
//   page_id   ::= alphanums
//   value     ::= alphanums
//
//   op ::=
//     | W_<txn_id>(<page_id>, <value>)
//     | Commit_<txn_id>()
//     | Flush(<page_id>)
//     | Checkpoint()
//
// This function assumes that the Parsimmon library is loaded.
aries.Op.parse_op = function() {
  var P = Parsimmon;

  var underscore = P.string("_");
  var lparen = P.string("(");
  var rparen = P.string(")");
  var comma = P.string(",");

  var alphanums = P.alt(P.letter, P.digit).atLeast(1).map(function(xs) {
    return xs.join("");
  });
  var txn_id = alphanums;
  var page_id = alphanums;
  var value = alphanums;

  var write = P.seqMap(
    P.string("W").then(underscore),
    txn_id,
    P.optWhitespace.then(lparen).then(P.optWhitespace),
    page_id,
    comma.then(P.optWhitespace),
    value,
    P.optWhitespace.then(rparen),
    function(_, txn_id, _, page_id, _, value, _) {
      return new aries.Op.Write(txn_id, page_id, value);
    }
  );

  var commit = P.seqMap(
    P.string("Commit").then(underscore),
    txn_id,
    P.optWhitespace.then(lparen).then(P.optWhitespace).then(rparen),
    function(_, txn_id,_) {
      return new aries.Op.Commit(txn_id);
    }
  );

  var flush = P.seqMap(
    P.string("Flush").then(P.optWhitespace).then(lparen).then(P.optWhitespace),
    page_id,
    P.optWhitespace.then(rparen),
    function(_, page_id, _) {
      return new aries.Op.Flush(page_id);
    }
  );

  var checkpoint = P.string("Checkpoint")
                    .then(P.optWhitespace)
                    .then(lparen)
                    .then(P.optWhitespace)
                    .then(rparen).map(function(_) {
                      return new aries.Op.Checkpoint()
                    });

  return P.alt(write, commit, flush, checkpoint);
}

// `aries.Op.parse_ops(s: string) -> aries.Op.Operation list` parses a list of
// operations from a string using the following grammar.
//
//   ops ::= (op,)*(op,?)?
aries.Op.parse_ops = function(s) {
  var P = Parsimmon;
  var comma = P.string(",");
  var op = aries.Op.parse_op();
  var ops = P.seqMap(
      P.optWhitespace
       .then(op)
       .skip(P.optWhitespace)
       .skip(comma)
       .skip(P.optWhitespace)
       .atLeast(0),
      P.optWhitespace
       .then(op)
       .skip(P.optWhitespace)
       .skip(comma.atMost(1))
       .skip(P.optWhitespace)
       .atMost(1),
      function(head, tail) {
        return head.concat(tail);
      }
  )
  return ops.parse(s);
}

// Log.
//
// The main ARIES data structure is a log. As ARIES runs, it appends log
// entries to the tail of the log which is kept in memory. Certain operations
// force certain prefixes of the log to be forced to disk. For example, when a
// transaction commits, the log is flushed to disk. A log entry is either an
// update, commit, end, CLR, or checkpoint. Every log entry has a log sequence
// number (LSN) and a type, but each log entry has a different set of data
// associated with it. The log is represented by the following types:
//
//   type Log.Entry = {
//     lsn:              number,
//     type:             aries.Log.Type,
//     txn_id:           string,
//     page_id:          string,
//     before:           string,
//     after:            string,
//     undo_next_lsn:    number,
//     dirty_page_table: DirtyPageTable,
//     txn_table:        TxnTable,
//     prev_lsn:         number, // or undefined
//   }
//
//   | command          | update | commit | end | clr | checkpoint |
//   | ---------------- | ------ | ------ | --- | --- | ---------- |
//   | lsn              | y      | y      | y   | y   | y          |
//   | type             | y      | y      | y   | y   | y          |
//   | txn_id           | y      | y      | y   | y   |            |
//   | page_id          | y      |        |     | y   |            |
//   | before           | y      |        |     |     |            |
//   | after            | y      |        |     | y   |            |
//   | undo_next_lsn    |        |        |     | y   |            |
//   | dirty_page_table |        |        |     |     | y          |
//   | txn_table        |        |        |     |     | y          |
//   | prev_lsn         | y      | y      | y   | y   |            |
//
// For convenience, a log entry's LSN is the same as its index in the log.
aries.Log = {};

aries.Log.Type = {
  UPDATE:     "update",
  COMMIT:     "commit",
  END:        "end",
  CLR:        "clr",
  CHECKPOINT: "checkpoint",
}

aries.Log.Entry = function(type, lsn) {
  this.type = type;
  this.lsn = lsn;
}

aries.Log.Update = function(lsn, txn_id, page_id, before, after, prev_lsn) {
  aries.Log.Entry.call(this, aries.Log.Type.UPDATE, lsn);
  this.txn_id = txn_id;
  this.page_id = page_id;
  this.before = before;
  this.after = after;
  this.prev_lsn = prev_lsn;
}

aries.Log.Commit = function(lsn, txn_id, prev_lsn) {
  aries.Log.Entry.call(this, aries.Log.Type.COMMIT, lsn);
  this.txn_id = txn_id;
  this.prev_lsn = prev_lsn;
}

aries.Log.End = function(lsn, txn_id, prev_lsn) {
  aries.Log.Entry.call(this, aries.Log.Type.END, lsn);
  this.txn_id = txn_id;
  this.prev_lsn = prev_lsn;
}

aries.Log.CLR = function(lsn, txn_id, page_id, after, undo_next_lsn, prev_lsn) {
  aries.Log.Entry.call(this, aries.Log.Type.CLR, lsn);
  this.txn_id = txn_id;
  this.page_id = page_id;
  this.after = after;
  this.undo_next_lsn = undo_next_lsn;
  this.prev_lsn = prev_lsn;
}

aries.Log.Checkpoint = function(lsn, dirty_page_table, txn_table) {
  aries.Log.Entry.call(this, aries.Log.Type.CHECKPOINT, lsn);
  this.dirty_page_table = dirty_page_table;
  this.txn_table = txn_table;
}

// Transaction Table.
//
// The transaction table records whether every transaction is in progress,
// committed, or aborted. It also records, for each transaction, the LSN of the
// most recent log entry that was performed by the transaction. This is dubbed
// the lastLSN of a transaction. The transaction table is represented by the
// following types:
//
//   type TxnTableEntry = {
//     txn_status: aries.TxnStatus,
//     last_lsn:   number,
//   }
//
//   type TxnTable = txn_id: string -> TxnTableEntry
//
// TxnTable is a map (i.e. Javascript object) mapping strings to TxnTableEntry
// objects.
aries.TxnStatus = {
  IN_PROGRESS: "in progress",
  COMMITTED:   "committed",
  ABORTED:     "aborted",
}

aries.TxnTableEntry = function(txn_status, last_lsn) {
  this.txn_status = txn_status;
  this.last_lsn = last_lsn;
}

// Dirty Page Table.
//
// The dirty page table records, for each page, the LSN of the oldest log entry
// that dirtied the page. This is dubbed the recLSN of the page. The dirty page
// table is represented by the following types:
//
//   type DirtyPageTableEntry = {
//     rec_lsn: number,
//   }
//
//   type DirtyPageTable = page_id: string -> DirtyPageTableEntry
aries.DirtyPageTableEntry = function(rec_lsn) {
  this.rec_lsn = rec_lsn;
}

// Buffer Pool and Disk.
//
// When pages are written to, they are read from the disk into a cache known as
// the buffer pool. Every page has a corresponding value, and also includes a
// pageLSN: the LSN of the most recent log entry that modified the contents of
// the page. The buffer pool and disk are represented by the following types:
//
//   type Page = {
//     page_lsn: string,
//     value: string,
//   }
//
//   type BufferPool = page_id: string -> Page
//   type Disk = page_id: string -> Page
aries.Page = function(page_lsn, value) {
  this.page_lsn = page_lsn;
  this.value = value;
}

// State.
//
// The state of ARIES is the aggregate of the log, transaction table, dirty
// page table, buffer pool, and disk. In addition to the state of the
// algorithm, we also want to keep track of various bits of metadata that is
// useful for the front end. For example, we may want to keep track of which
// phase of the algorithm we are in, or keep track of our position in the
// operation list. All these things are also included in the state.
//
//   type aries.Phase =
//     | NORMAL
//     | ANALYSIS
//     | REDO
//     | UNDO
//     | CRASHED
//
//   type state = {
//     // The phase the algorithm is currently in.
//     phase: aries.Phase,
//
//     // A set of descriptive message on what the current state of the system
//     // is and how the state changed since the last state. For example, if we
//     // just processed an update log record and introduced a new entry to the
//     // transaction table, we might include a message like "This update is
//     // first update of transaction A, so it is inserted into the transaction
//     // table."
//     explanation: string list,
//
//     // The list of operations parsed from the user.
//     ops: aries.Op.Operation list,
//
//     // The number of operations that have been processed. When ARIES begins,
//     // this will be 0. After ARIES crashes, this will be equal to the number
//     // of operations.
//     num_ops_processed: number,
//
//     // The log.
//     log: aries.Log.Entry list,
//
//     // The number of log entries that have been flushed to disk.
//     num_flushed: number,
//
//     // The log looks like this:
//     //
//     //     +---------+
//     //     |    0    |
//     //     +---------+
//     //     |    1    |
//     //     +---------+
//     //     |    2    |
//     //     +---------+
//     //
//     // At various points in time, ARIES is scanning through the log. For
//     // example, during the analysis phase, ARIES scans forward through the
//     // log. After it has scanned through two of the entries and is about to
//     // scan the third, we can draw the position of the ARIES algorithm like
//     // this:
//     //
//     //     +---------+
//     //     |    0    |
//     //     +---------+
//     //     |    1    |
//     //     +---------+ <----- position = 2
//     //     |    2    |
//     //     +---------+
//     //
//     // `log_position` is the number of entries the position should point
//     // after. Here, the position is 2 because it's pointing right after 2
//     // elements. If `log_position` is undefined, then no pointer should be
//     // shown.
//     log_position: number,
//
//     // The transaction table.
//     txn_table: TxnTable,
//
//     // The dirty page table.
//     dirty_page_table: DirtyPageTable,
//
//     // The buffer pool.
//     buffer_pool: BufferPool,
//
//     // The disk.
//     disk: Disk,
//   }
aries.Phase = {
  NORMAL:   "normal",
  ANALYSIS: "analysis",
  REDO:     "redo",
  UNDO:     "undo",
  CRASHED:  "crashed",
}

aries.State = function(ops) {
  this.phase = aries.Phase.NORMAL;
  this.explanation = [];
  this.ops = ops;
  this.num_ops_processed = 0;
  this.log = [];
  this.num_flushed = 0;
  this.log_position = undefined;
  this.txn_table = {};
  this.dirty_page_table = {};
  this.buffer_pool = {};
  this.disk = {};
}

// Helper Functions ////////////////////////////////////////////////////////////
// `deep_copy(x)` returns a deep copy of `x`. This code is taken from
// http://stackoverflow.com/a/5344074/3187068.
aries.deep_copy = function(x) {
  return JSON.parse(JSON.stringify(x));
}

// `aries.is_object_empty(x)` returns whether the Javascript object `x` is
// empty. See https://goo.gl/KgXgio for implementation.
aries.is_object_empty = function(x) {
  return Object.keys(x).length === 0;
}

// `pages_accessed(ops: Operation list)` returns a list of the page ids of
// every page referenced in ops. The list may contain duplicates. For example,
//
//   var ops = [
//     {type: WRITE,  txn_id:"1", page_id:"A", value:"foo"},
//     {type: WRITE,  txn_id:"2", page_id:"B", value:"bar"},
//     {type: COMMIT, txn_id:"1"                          },
//     {type: FLUSH,              page_id:"B"             }
//   ];
//   aries.pages_accessed(ops) // ["A", "B"]
aries.pages_accessed = function(ops) {
  var page_ids = [];
  for (var i = 0; i < ops.length; i++) {
    if (ops[i].type === aries.Op.Type.WRITE ||
        ops[i].type === aries.Op.Type.FLUSH) {
      page_ids.push(ops[i].page_id);
    }
  }
  return page_ids;
}

// `aries.latest_checkpoint_lsn(state: State)` returns the latest LSN of any
// checkpoint in the log, or 0 if no checkpoints exist.
aries.latest_checkpoint_lsn = function(state) {
  var lsn = 0;
  for (var i = 0; i < state.log.length; i++) {
    if (state.log[i].type === aries.Op.Type.CHECKPOINT) {
      lsn = i;
    }
  }
  return lsn;
}

// `aries.min_rec_lsn(state: State)` returns the minimum recLSN in the dirty
// page table or undefined if the dirty page table is empty.
aries.min_rec_lsn = function(state) {
  var min = undefined;
  for (var page_id in state.dirty_page_table) {
    var rec_lsn = state.dirty_page_table[page_id].rec_lsn;
    if (typeof min === "undefined") {
      min = rec_lsn
    } else {
      min = Math.min(min, rec_lsn);
    }
  }
  return min;
}

// `pin(state: State, page_id: string)` ensures that the page with page id
// `page_id` is pinned in the buffer pool. That is, if the page is already in
// the buffer pool, then this function no-ops. If it isn't, then it is fetched
// from disk.
aries.pin = function(state, page_id) {
  console.assert(page_id in state.disk);
  if (!(page_id in state.buffer_pool)) {
    state.buffer_pool[page_id] = aries.deep_copy(state.disk[page_id]);
    state.explanation.push(
      "Page " + page_id + " was fetched from disk and brought into the " +
      "buffer pool."
    );
  }
}

// `flush(state: State, page_id: string)` is the dual of `aries.pin`; it evicts
// a page from the buffer pool into the disk.
aries.flush = function(state, page_id) {
  console.assert(page_id in state.disk);
  if (page_id in state.buffer_pool) {
    state.disk[page_id] = aries.deep_copy(state.buffer_pool[page_id]);
    delete state.buffer_pool[page_id];
  }
}

// `aries.dirty(state: State, page_id: string, rec_lsn: number)` ensures that
// the page with page id `page_id` is in the dirty page table. If the page is
// already in the dirty page table, then this function no-ops. Otherwise, it
// enters it into the dirty page table with recLSN `rec_lsn`.
aries.dirty = function(state, page_id, rec_lsn) {
  console.assert(page_id in state.disk);
  if (!(page_id in state.dirty_page_table)) {
    state.dirty_page_table[page_id] = new aries.DirtyPageTableEntry(rec_lsn);
    state.explanation.push(
      "Page " + page_id + " was brought into the dirty page table with recLSN "
      + rec_lsn + "."
    );
  } else {
    state.explanation.push(
      "Page " + page_id + " was already in the dirty page table."
    );
  }
}

// `aries.begin_txn(state: State, txn_id: string)` ensures that a transaction
// with transaction id `txn_id` is in the transaction table. If the transaction
// is already in the transaction table, then this no-ops. Otherwise, it enters
// it into the transaction table with undefined status and undefined lastLSN.
aries.begin_txn = function(state, txn_id) {
  if (!(txn_id in state.txn_table)) {
    state.txn_table[txn_id] = new aries.TxnTableEntry(undefined, undefined);
    state.explanation.push(
      "This is the first operation of transaction " + txn_id + ", so an " +
      "entry for the transaction is put in the transaction table."
    );
  } else {
    state.explanation.push(
      "Transaction " + txn_id + " was already in the transaction table."
    );
  }
}

// `aries.flush_log(state: State, lsn: number)` ensures the log is flushed up
// to at least `lsn`.
aries.flush_log = function(state, lsn) {
  // When we flush a log entry with LSN `lsn`, there are `lsn + 1` entries
  // flushed. For example, if we flush a single log entry, it has an LSN of 0,
  // but there are 1 entries flushed.
  state.num_flushed = Math.max(state.num_flushed, lsn + 1);
}

// `aries.rec_lsn(state: State, page_id: string)` returns the recLSN of the
// page in the dirty page table, or undefined if its not in the dirty page
// table.
aries.rec_lsn = function(state, page_id) {
  return page_id in state.dirty_page_table ?
    state.dirty_page_table[page_id].rec_lsn :
    undefined;
}

// `aries.last_lsn(state: State, txn_id: string)` returns the transaction id of
// the transaction in the transaction table, or undefined if its not in the
// transaction table.
aries.last_lsn = function(state, txn_id) {
  return txn_id in state.txn_table ?
    state.txn_table[txn_id].last_lsn :
    undefined;
}

// `aries.page_lsn(state: State, page_id: string)` returns the pageLSN of the
// page in the buffer pool, or undefined if its not in the buffer pool. The
// pageLSN is not read from disk if the page is not in the buffer pool.
aries.page_lsn = function(state, page_id) {
  return page_id in state.buffer_pool ?
    state.buffer_pool[page_id].page_lsn :
    undefined;
}

// Init ////////////////////////////////////////////////////////////////////////
// Our ARIES simulator allows operations to write to pages with arbitrary page
// ids. `aries.init(state: aries.State, ops: aries.Op.Operation list)` ensures
// that all the pages referenced in ops are in the disk.
aries.init = function(state, ops) {
  var page_ids = aries.pages_accessed(ops);
  for (var i = 0; i < page_ids.length; i++) {
    state.disk[page_ids[i]] = new aries.Page(-1, "\u22A5");
  }
  state.explanation.push(
    "ARIES is in its initial state: no operations have been processed, and " +
    "all in memory data structures are empty. Moreover, all pages on disk " +
    "are initialized to a dummy pageLSN of -1 and a dummy value \u22A5."
  );
}

// Forward Processing //////////////////////////////////////////////////////////
// `aries.process_write(state: State, write: Operation)` processes a write
// operation.
aries.process_write = function(state, write) {
  console.assert(write.type === aries.Op.Type.WRITE);
  var lsn = state.log.length;

  // Bring the page into the buffer pool, if necessary, and update it.
  aries.pin(state, write.page_id);
  var before = state.buffer_pool[write.page_id].value;
  state.buffer_pool[write.page_id].page_lsn = lsn;
  state.buffer_pool[write.page_id].value = write.value;
  state.explanation.push(
    "The value of page " + write.page_id + " was updated from '" + before +
    "' to '" + write.value + "' in the buffer pool, and the pageLSN was " +
    "updated to " + lsn + "."
  );

  // Update the dirty page table, if necessary.
  aries.dirty(state, write.page_id, lsn);

  // Introduce a new transaction into the transaction table, if necessary,
  // and update it.
  var prev_lsn = aries.last_lsn(state, write.txn_id);
  aries.begin_txn(state, write.txn_id);
  state.txn_table[write.txn_id].txn_status = aries.TxnStatus.IN_PROGRESS;
  state.txn_table[write.txn_id].last_lsn = lsn;

  // write update record
  state.log.push(new aries.Log.Update(lsn, write.txn_id, write.page_id,
        before, write.value, prev_lsn));
  state.explanation.push(
    "Finally, an update log entry is appended to the log; all write " +
    "operations generate update log entries."
  );
}

// `aries.process_commit(state: State, commit: Operation)` processes a commit
// operation.
aries.process_commit = function(state, commit) {
  console.assert(commit.type === aries.Op.Type.COMMIT);

  // Write commit and end.
  var commit_lsn = state.log.length;
  var end_lsn = commit_lsn + 1;
  var prev_lsn = aries.last_lsn(state, commit.txn_id)
  state.log.push(new aries.Log.Commit(commit_lsn, commit.txn_id, prev_lsn));
  state.log.push(new aries.Log.End(end_lsn, commit.txn_id, commit_lsn));

  // Flush the log.
  aries.flush_log(state, end_lsn);

  // Clear the transaction from the transaction table.
  delete state.txn_table[commit.txn_id];

  state.explanation.push(
    "First, we append a commit and end log record to the log. Then, we " +
    "flush the log and remove transaction " + commit.txn_id + " from the " +
    "transaction table. The moment the commit log entry is persisted is " +
    "when the transaction is considered committed."
  );
}

// `aries.process_checkpoint(state: State, checkpoint: Operation)` processes a
// checkpoint operation.
aries.process_checkpoint = function(state, checkpoint) {
  console.assert(checkpoint.type === aries.Op.Type.CHECKPOINT);
  var lsn = state.log.length;
  state.log.push(new aries.Log.Checkpoint(lsn,
        aries.deep_copy(state.dirty_page_table),
        aries.deep_copy(state.txn_table)));
  state.explanation.push(
    "A copy of the dirty page table and transaction table are stored in the " +
    "checkpoint log entry."
  );
}

// `aries.process_flush(state: State, flush: Operation)` processes a flush
// operation.
aries.process_flush = function(state, flush) {
  console.assert(flush.type === aries.Op.Type.FLUSH);

  // Flush the log.
  var page_lsn = aries.page_lsn(state, flush.page_id);
  if (typeof page_lsn === "undefined") {
    // If the page isn't in the buffer pool, then it must have already been
    // flushed to disk, so we don't have to do anything.
    console.assert(!(flush.page_id in state.dirty_page_table));
    state.explanation.push(
      "Page " + flush.page_id + " is not dirty, so the flush is essentially " +
      "a no-op."
    );
    return;
  }
  state.explanation.push(
    "The pageLSN of page " + flush.page_id + " is " + page_lsn + ". That " +
    "is, log entry " + page_lsn + " was the most recent log entry to modify " +
    "page " + flush.page_id + ". To ensure recoverability, we must ensure " +
    "that every log entry up to and including entry " + page_lsn +
    " is flushed."
  );
  aries.flush_log(state, page_lsn);

  // Flush the page to disk.
  aries.flush(state, flush.page_id);

  // Clear the dirty page table.
  delete state.dirty_page_table[flush.page_id];

  state.explanation.push(
    "Finally, we flush page " + flush.page_id + " from the buffer pool to " +
    "disk, and remove the corresponding entries in the dirty page table and " +
    "buffer pool."
  );
}

// `aries.forward_process(states: aries.State list, ops: aries.Op.Operation
// list)` processes a sequence of operations during normal database operation.
// Starting with `states[states.length - 1]`, `forward_process` iteratively
// applies an operation to create a new state and appends it to states.
aries.forward_process = function(states, ops) {
  var state = aries.deep_copy(states[states.length - 1]);
  for (var i = 0; i < ops.length; i++) {
    var op = ops[i];
    state.explanation = [aries.Op.explain(op)];
    if (op.type === aries.Op.Type.WRITE) {
      aries.process_write(state, op);
    } else if (op.type === aries.Op.Type.COMMIT) {
      aries.process_commit(state, op);
    } else if (op.type === aries.Op.Type.CHECKPOINT) {
      aries.process_checkpoint(state, op);
    } else if (op.type === aries.Op.Type.FLUSH) {
      aries.process_flush(state, op);
    } else {
      console.assert(false, "Invalid operation type: " + op.type +
                     " in operation " + op);
    }
    state.num_ops_processed += 1;
    states.push(state);
    state = aries.deep_copy(state);
  }
}

// Crash ///////////////////////////////////////////////////////////////////////
// `aries.crash(state: State)` simulates ARIES crashing by clearing all
// non-ephemeral data.
aries.crash = function(state) {
  state.phase = aries.Phase.CRASHED;
  state.log = state.log.slice(0, state.num_flushed);
  state.dirty_page_table = {};
  state.txn_table = {};
  state.buffer_pool = {};
  state.explanation = [
    "ARIES crashed! The in-memory data structures (i.e. the dirty page " +
    "table, the transaction table, the buffer pool, and the unflushed tail " +
    "of the log) are all cleared. The only thing that remains is the " +
    "flushed head of the log and the disk."
  ];
}

// Analysis ////////////////////////////////////////////////////////////////////
// `aries.analysis_update(state: State, update: LogEntry)` processes a update
// operation during the analysis phase.
aries.analysis_update = function(state, update) {
  state.explanation.push(
    "Transaction " + update.txn_id + " updated page " + update.page_id + "."
  );

  // Update the dirty page table.
  aries.dirty(state, update.page_id, update.lsn);

  // Update the transaction table.
  aries.begin_txn(state, update.txn_id);
  state.txn_table[update.txn_id].last_lsn = update.lsn;
}

// `aries.analysis_commit(state: State, commit: LogEntry)` processes a commit
// operation during the analysis phase.
aries.analysis_commit = function(state, commit) {
  state.explanation.push(
    "Transaction " + commit.txn_id + " committed."
  );

  // Update the transaction table.
  aries.begin_txn(state, commit.txn_id);
  state.txn_table[commit.txn_id].txn_status = aries.TxnStatus.COMMITTED;
  state.txn_table[commit.txn_id].last_lsn = commit.lsn;
  state.explanation.push(
    "Transaction " + commit.txn_id + "'s status was set to 'committed' in " +
    "the transaction table."
  );
}

// `aries.analysis_end(state: State, end: LogEntry)` processes an end operation
// during the analysis phase.
aries.analysis_end = function(state, end) {
  state.explanation.push(
    "Transaction " + end.txn_id + " ended and was removed from the " +
    "transaction table."
  );
  // Remove the transaction from the transaction table.
  delete state.txn_table[end.txn_id];
}

// `aries.analysis_clr(state: State, clr: LogEntry)` processes a clr operation
// during the analysis phase.
aries.analysis_clr = function(state, log_entry) {
  console.assert(false, "Our ARIES simulator doesn't support repeated " +
                        "crashes, so the analysis should never see a CLR log " +
                        "entry.");
}

// `aries.analysis_checkpoint(state: State, checkpoint: LogEntry)` processes a
// checkpoint operation during the analysis phase.
aries.analysis_checkpoint = function(state, checkpoint) {
  console.assert(checkpoint.type === aries.Log.Type.CHECKPOINT);

  var state_cleared = aries.is_object_empty(state.dirty_page_table) &&
                      aries.is_object_empty(state.txn_table) &&
                      aries.is_object_empty(state.buffer_pool);
  console.assert(state_cleared, "Analysis should see at most checkpoint. If " +
                                "that checkpoint is encountered, it better be " +
                                "the first thing encountered!");

  state.dirty_page_table = aries.deep_copy(checkpoint.dirty_page_table);
  state.txn_table = aries.deep_copy(checkpoint.txn_table);
  state.explanation.push(
    "The dirty page table and transaction table are loaded from the checkpoint."
  );
}

// `aries.analysis(states: aries.State list, ops: aries.Op.Operation list)`
// simulates the analysis phase of ARIES.  Starting with `states[states.length
// - 1]`, `analysis` iteratively applies analyzes a log entry to create a new
// state and appends it to states.
aries.analysis = function(states) {
  var state = aries.deep_copy(states[states.length - 1]);
  var start_lsn = aries.latest_checkpoint_lsn(state);
  state.phase = aries.Phase.ANALYSIS;
  state.log_position = start_lsn;

  for (var i = start_lsn; i < state.log.length; i++) {
    var log_entry = state.log[i];
    if (i == start_lsn) {
      if (log_entry.type === aries.Log.Type.CHECKPOINT) {
        state.explanation = [
          "ARIES began its analysis phase at LSN " + start_lsn + ": the LSN " +
          "of the most recent checkpoint."
        ];
      } else {
        state.explanation = [
          "There were no checkpoints, so ARIES began its analysis phase at " +
          "the beginning of the log."
        ];
      }
    } else {
      state.explanation = [];
    }

    if (log_entry.type === aries.Log.Type.UPDATE) {
      aries.analysis_update(state, log_entry);
    } else if (log_entry.type === aries.Log.Type.COMMIT) {
      aries.analysis_commit(state, log_entry);
    } else if (log_entry.type === aries.Log.Type.END) {
      aries.analysis_end(state, log_entry);
    } else if (log_entry.type === aries.Log.Type.CLR) {
      aries.analysis_clr(state, log_entry);
    } else if (log_entry.type === aries.Log.Type.CHECKPOINT) {
      aries.analysis_checkpoint(state, log_entry);
    } else {
      console.assert(false, "Invalid log type: " + log_entry.type +
                     " in operation " + log_entry);
    }
    state.log_position += 1;
    states.push(state);
    state = aries.deep_copy(state);
  }

  // After the analysis phase, any in progress transactions should be treated
  // as aborted.
  for (var txn_id in state.txn_table) {
    if (state.txn_table[txn_id].txn_status === aries.TxnStatus.IN_PROGRESS) {
      state.txn_table[txn_id].txn_status = aries.TxnStatus.ABORTED;
    }
  }
  state.explanation = [
    "ARIES completed its analysis phase and marked in progress transactions " +
    "as aborted."
  ];
  states.push(state);
}

// Redo ////////////////////////////////////////////////////////////////////////
// `aries.redo_update(state: State, update: LogEntry)` processes a update
// operation during the redo phase.
aries.redo_update = function(state, update) {
  state.explanation.push(
    "Transaction " + update.txn_id + " updated page " + update.page_id + "."
  );

  // An update to a page need not be redone if
  //   1. the page is not in the dirty page table;
  //   2. the page is in the dirty page table, and the recLSN is greater than
  //      the LSN of the update; or
  //   3. the recLSN on disk is greater than or equal to the LSN of the update.
  if (!(update.page_id in state.dirty_page_table)) {
    state.explanation.push(
      "Condition 1 was met: page " + update.page_id + " was not in the " +
      "dirty page table. So, the update was not redone."
    );
    return;
  }
  var dpt_rec_lsn = state.dirty_page_table[update.page_id].rec_lsn;
  if (dpt_rec_lsn > update.lsn) {
    state.explanation.push(
      "Condition 2 was met: page " + update.page_id + " was in the dirty " +
      "page table, but its recLSN of " + dpt_rec_lsn + " is greater than " +
      "the LSN of this log entry: " + update.lsn + ". So, the update was " +
      "not redone."
    );
    return;
  }
  var disk_page_lsn = state.disk[update.page_id].page_lsn;
  if (disk_page_lsn >= update.lsn) {
    state.explanation.push(
      "Condition 3 was met: the pageLSN of page " + update.page_id +
      " on disk was " + disk_page_lsn + " which is greater than or equal to " +
      "the LSN of this log entry: " + update.lsn + ". So, the update was " +
      "not redone."
    );
    return;
  }

  state.explanation.push(
    "The update did not meet any of condition 1, 2, or 3 and so was redone."
  );
  aries.pin(state, update.page_id);
  state.buffer_pool[update.page_id].page_lsn = update.lsn;
  state.buffer_pool[update.page_id].value = update.after;
}

// `aries.redo_commit(state: State, commit: LogEntry)` processes a commit
// operation during the redo phase.
aries.redo_commit = function(state, commit) {
  state.explanation.push("Commit log entries are not redone.");
}

// `aries.redo_end(state: State, end: LogEntry)` processes an end operation
// during the redo phase.
aries.redo_end = function(state, end) {
  state.explanation.push("End log entries are not redone.");
}

// `aries.redo_clr(state: State, clr: LogEntry)` processes a clr operation
// during the redo phase.
aries.redo_clr = function(state, clr) {
  console.assert(false, "Our ARIES simulator doesn't support repeated " +
                        "crashes, so the redo should never see a CLR log " +
                        "entry.");
}

// `aries.redo_checkpoint(state: State, checkpoint: LogEntry)` processes a
// checkpoint operation during the redo phase.
aries.redo_checkpoint = function(state, checkpoint) {
  state.explanation.push("Checkpoint log entries are not redone.");
}

// `aries.redo(states: aries.State list, ops: aries.Op.Operation list)`
// simulates the redo phase of ARIES.  Starting with `states[states.length -
// 1]`, `redo` iteratively redoes log entries to create a new state and appends
// it to states.
aries.redo = function(states) {
  var state = aries.deep_copy(states[states.length - 1]);
  var start_lsn = aries.min_rec_lsn(state);
  state.phase = aries.Phase.REDO;
  state.log_position = start_lsn;

  if (typeof start_lsn === "undefined") {
    // If there are no dirty pages, then we have nothing to redo!
    return;
  }

  for (var i = start_lsn; i < state.log.length; i++) {
    var log_entry = state.log[i];
    if (i == start_lsn) {
      state.explanation = [
        "ARIES began its REDO phase at LSN " + start_lsn + ": the smallest " +
        "recLSN in the dirty page table."
      ];
    } else {
      state.explanation = [];
    }

    if (log_entry.type === aries.Log.Type.UPDATE) {
      aries.redo_update(state, log_entry);
    } else if (log_entry.type === aries.Log.Type.COMMIT) {
      aries.redo_commit(state, log_entry);
    } else if (log_entry.type === aries.Log.Type.END) {
      aries.redo_end(state, log_entry);
    } else if (log_entry.type === aries.Log.Type.CLR) {
      aries.redo_clr(state, log_entry);
    } else if (log_entry.type === aries.Log.Type.CHECKPOINT) {
      aries.redo_checkpoint(state, log_entry);
    } else {
      console.assert(false, "Invalid log type: " + log_entry.type +
                     " in operation " + log_entry);
    }
    state.log_position += 1;
    states.push(state);
    state = aries.deep_copy(state);
  }
}

// Undo ////////////////////////////////////////////////////////////////////////
// `aries.undo(states: aries.State list, ops: aries.Op.Operation list)`
// simulates the undo phase of ARIES.  Starting with `states[states.length -
// 1]`, `undo` iteratively undoes log entries to create a new state and appends
// it to states.
aries.undo = function(states) {
  var state = aries.deep_copy(states[states.length - 1]);
  state.phase = aries.Phase.UNDO;

  var losers = [];
  for (var page_id in state.txn_table) {
    losers.push(state.txn_table[page_id].last_lsn);
  }

  state.explanation = [
    "ARIES began its UNDO phase by collecting the set of \"losers LSNs\": " +
    "the lastLSNs of all transactions in the transaction table."
  ];

  while (losers.length > 0) {
    state.explanation.push("The loser LSNs were " + losers + ".");
    // Get the loser log entry. We repeatedly sort the loser transaction LSNs
    // and pop the last (i.e. biggest) LSN.
    losers.sort();
    var loser = losers.pop();
    var loser_entry = state.log[loser];
    console.assert(loser_entry.type === aries.Log.Type.UPDATE,
        "Our ARIES simulator doesn't support repeated crashes, so the undo " +
        "phase should never see a CLR log entry.");
    state.explanation.push(
      "The largest loser LSNs was " + loser + ", so log entry " + loser +
      " was undone. A CLR entry was appended to the log, the transaction " +
      "table was updated accordingly, and the update was undone in the " +
      "buffer pool."
    );

    // Append a CLR entry.
    var clr_lsn = state.log.length;
    var undo_next_lsn = loser_entry.prev_lsn;
    var after = loser_entry.before;
    var prev_lsn = aries.last_lsn(state, loser_entry.txn_id);
    state.log.push(new aries.Log.CLR(clr_lsn, loser_entry.txn_id,
          loser_entry.page_id, undo_next_lsn, after, prev_lsn));

    // Undo the log entry.
    aries.pin(state, loser_entry.page_id);
    state.buffer_pool[loser_entry.page_id].page_lsn = clr_lsn;
    state.buffer_pool[loser_entry.page_id].value = after;

    // Update the transaction table.
    state.txn_table[loser_entry.txn_id].last_lsn = clr_lsn;

    if (typeof undo_next_lsn !== "undefined") {
      // Update the loser transactions.
      losers.push(undo_next_lsn);
      state.explanation.push(
        "The prevLSN of log entry " + loser + " is " + undo_next_lsn +
        " which is added to the loser LSNs."
      );
    } else {
      // End a completely undone transaction and remove it from the transaction
      // table.
      state.log.push(new aries.Log.End(state.log.length, loser_entry.txn_id,
                                   clr_lsn));
      delete state.txn_table[loser_entry.txn_id];
      state.explanation.push(
        "Log entry " + loser + " was the first update of transaction " +
        loser_entry.txn_id + ", so an end log entry was appended to the log " +
        "to end transaction " + loser_entry.txn_id + ", and it was removed " +
        "from the transaction table."
      );
    }

    state.log_position = loser_entry.lsn;
    states.push(state);
    state = aries.deep_copy(state);
    state.explanation = [];
  }

  state.explanation = [
    "ARIES finished! The effects of all committed transactions have been " +
    "applied, and the effects of all aborted transactions have been reverted."
  ];
  states.push(state);
}

// Main ////////////////////////////////////////////////////////////////////////
// `aries.simulate(ops: aries.Op.Operation list)` simulates the execution of
// ARIES on the list of operations `ops`. `simulate` returns a list of
// aries.States: each one produced from the last by processing an operation (as
// part of the forward processing phase) or by processing a log entry (as part
// of the analysis, redo, or undo phase).
aries.simulate = function(ops) {
  var initial_state = new aries.State(ops);
  var states = [initial_state]

  aries.init(initial_state, ops);
  aries.forward_process(states, ops);
  var crash_state = aries.deep_copy(states[states.length - 1]);
  aries.crash(crash_state);
  states.push(crash_state);
  aries.analysis(states);
  aries.redo(states);
  aries.undo(states);
  return states;
}
