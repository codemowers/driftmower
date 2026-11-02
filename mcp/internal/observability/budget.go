package observability

import (
	"container/list"
	"fmt"
	"math"
	"sync"
	"time"
)

// Budget admits a caller's tool calls: a cap on calls in flight, and a token
// bucket charged per backend request the call makes, so a call that fans out
// to a dozen queries pays for a dozen. The balance may go negative mid-call,
// which delays the caller's next call.
type Budget struct {
	// Backend requests per caller per minute, also the burst; 0 is unlimited.
	QueriesPerMinute   int
	MaxConcurrentCalls int
	// Callers tracked at once; the least recently seen idle one is dropped.
	MaxCallers int
	Now        func() time.Time

	mu      sync.Mutex
	order   *list.List
	callers map[string]*list.Element
}

type callerState struct {
	key      string
	tokens   float64
	refilled time.Time
	calls    int
}

func (b *Budget) now() time.Time {
	if b.Now != nil {
		return b.Now()
	}

	return time.Now()
}

// state returns the caller's refilled state; b.mu must be held.
func (b *Budget) state(key string) *callerState {
	if b.callers == nil {
		b.callers, b.order = map[string]*list.Element{}, list.New()
	}
	rate := float64(b.QueriesPerMinute)
	var s *callerState
	if el, ok := b.callers[key]; ok {
		s = el.Value.(*callerState)
		b.order.MoveToBack(el)
	} else {
		max := b.MaxCallers
		if max <= 0 {
			max = 10_000
		}
		if len(b.callers) >= max {
			for el := b.order.Front(); el != nil; el = el.Next() {
				if old := el.Value.(*callerState); old.calls == 0 {
					b.order.Remove(el)
					delete(b.callers, old.key)

					break
				}
			}
		}
		s = &callerState{key: key, tokens: rate, refilled: b.now()}
		b.callers[key] = b.order.PushBack(s)
	}
	if rate > 0 {
		now := b.now()
		s.tokens = math.Min(rate, s.tokens+now.Sub(s.refilled).Minutes()*rate)
		s.refilled = now
	}

	return s
}

// Admit runs call when the caller is within budget. charge debits one backend
// request.
func (b *Budget) Admit(key string, call func(charge func()) error) error {
	b.mu.Lock()
	s := b.state(key)
	rate := float64(b.QueriesPerMinute)
	if rate > 0 && s.tokens < 1 {
		wait := int(math.Ceil((1 - s.tokens) * 60 / rate))
		b.mu.Unlock()

		return &Refused{Reason: "rate_limited", RetryAfterSeconds: wait, Message: fmt.Sprintf(
			"Too many observability queries from this caller (limit %d backend queries per minute); retry in %ds", b.QueriesPerMinute, wait)}
	}
	if s.calls >= b.MaxConcurrentCalls {
		calls := s.calls
		b.mu.Unlock()

		return &Refused{Reason: "caller_busy", RetryAfterSeconds: 1, Message: fmt.Sprintf(
			"This caller already has %d observability calls running (limit %d); wait for one to finish", calls, b.MaxConcurrentCalls)}
	}
	s.calls++
	b.mu.Unlock()

	defer func() {
		b.mu.Lock()
		s.calls--
		b.mu.Unlock()
	}()

	return call(func() {
		if rate > 0 {
			b.mu.Lock()
			s.tokens--
			b.mu.Unlock()
		}
	})
}
