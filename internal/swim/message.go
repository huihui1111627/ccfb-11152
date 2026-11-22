package swim

import "fmt"

// MessageKind enumerates the wire message types of SWIM + Lifeguard.
type MessageKind uint8

const (
	MsgPing MessageKind = iota
	MsgAck
	MsgPingReq
	MsgNack
	MsgJoin
	MsgJoinAck
	MsgLeavePush
	MsgRevive
	MsgReviveAck
	MsgDeadNotice
	MsgSuspectNotice
)

func (k MessageKind) String() string {
	switch k {
	case MsgPing:
		return "ping"
	case MsgAck:
		return "ack"
	case MsgPingReq:
		return "ping-req"
	case MsgNack:
		return "nack"
	case MsgJoin:
		return "join"
	case MsgJoinAck:
		return "join-ack"
	case MsgLeavePush:
		return "leave"
	case MsgRevive:
		return "revive"
	case MsgReviveAck:
		return "revive-ack"
	case MsgDeadNotice:
		return "dead-notice"
	case MsgSuspectNotice:
		return "suspect-notice"
	}
	return "?"
}

// UpdateKind is the type of a membership gossip entry.
type UpdateKind uint8

const (
	UpdateAlive UpdateKind = iota
	UpdateSuspect
	UpdateConfirm // "dead"
	UpdateLeave
)

func (k UpdateKind) String() string {
	switch k {
	case UpdateAlive:
		return "alive"
	case UpdateSuspect:
		return "suspect"
	case UpdateConfirm:
		return "confirm"
	case UpdateLeave:
		return "leave"
	}
	return "?"
}

// Update is one dissemination payload: the incarnation-numbered record of a
// membership change originated by Source with logical sequence number Seq.
type Update struct {
	Source   int        `json:"source"`
	Seq      uint64     `json:"seq"`
	Kind     UpdateKind `json:"kind"`
	About    int        `json:"about"`
	Inc      uint64     `json:"inc"`
	Transmit int        `json:"transmit"` // times this copy has been sent
}

func (u Update) String() string {
	return fmt.Sprintf("%s n%03d@%d", u.Kind, u.About, u.Inc)
}

// Message is a protocol datagram.
//
//	Origin is the member that started the probe (ack routing);
//	Target is the member being probed;
//	Relay  is the member currently holding the packet in an indirect probe.
type Message struct {
	Kind    MessageKind `json:"kind"`
	From    int         `json:"from"`
	To      int         `json:"to"`
	Seq     uint64      `json:"seq"`
	Origin  int         `json:"origin,omitempty"`
	Target  int         `json:"target,omitempty"`
	Relay   int         `json:"relay,omitempty"`
	Inc     uint64      `json:"inc,omitempty"`
	NoteInc uint64      `json:"note_inc,omitempty"` // dead-notice incarnation
	Piggy   []Update    `json:"piggy,omitempty"`
	Sync    []Update    `json:"sync,omitempty"`
	MemberN int         `json:"member_n,omitempty"`
	// Backlog is the sender's retransmit-buffer size when this datagram was
	// built; Piggy carries at most the packet budget's worth of it.
	Backlog int `json:"backlog,omitempty"`
}

// Size is the serialised size in bytes, used against the packet budget.
func (m Message) Size(cfg Config) int {
	n := cfg.HeaderBytes
	n += len(m.Piggy) * cfg.EntryBytes
	n += len(m.Sync) * cfg.EntryBytes
	return n
}

func nodeName(id int) string { return fmt.Sprintf("n%03d", id) }
