package backend

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
)

func TestQueryEncoding(t *testing.T) {
	q := Query{}.Set("sourceType", "cluster").Select("id", "status").Sort("createdAt", -1).Set("$limit", "100")
	encoded, _ := url.QueryUnescape(q.Encode())
	for _, want := range []string{"sourceType=cluster", "$select[0]=id", "$select[1]=status", "$sort[createdAt]=-1", "$limit=100"} {
		if !strings.Contains(encoded, want) {
			t.Errorf("%q lacks %q", encoded, want)
		}
	}
	if (Query{}).Encode() != "" {
		t.Error("empty query encodes to something")
	}
	// Sort keys keep their priority on the wire, whatever their names.
	sorted, _ := url.QueryUnescape(Query{}.Sort("zeta", 1).Sort("alpha", -1).Encode())
	if sorted != "$sort[zeta]=1&$sort[alpha]=-1" {
		t.Errorf("sort order = %q", sorted)
	}
}

type stubCall struct {
	url    *url.URL
	header http.Header
}

func stub(t *testing.T, handle func(r *http.Request, index int) (int, string)) (*Client, *[]stubCall) {
	t.Helper()
	var calls []stubCall
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, stubCall{url: r.URL, header: r.Header.Clone()})
		status, body := handle(r, len(calls)-1)
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)

	return &Client{BaseURL: srv.URL + "/", Token: "dm_svc_token"}, &calls
}

func pageBody(skip, total int) string {
	var ids []string
	for i := skip; i < min(skip+100, total); i++ {
		ids = append(ids, fmt.Sprintf(`{"id":"row-%d"}`, i))
	}

	return fmt.Sprintf(`{"total":%d,"limit":100,"skip":%d,"data":[%s]}`, total, skip, strings.Join(ids, ","))
}

type idRow struct {
	ID string `json:"id"`
}

func TestClientSendsTokenAndJoinsPath(t *testing.T) {
	c, calls := stub(t, func(*http.Request, int) (int, string) { return 200, `{"total":0,"data":[]}` })
	if _, err := findPage[idRow](ctx, c, "reports", Query{}.Set("status", "ready")); err != nil {
		t.Fatal(err)
	}
	// The trailing slash on the base URL must not produce a doubled separator.
	if got := (*calls)[0].url.String(); got != "/reports?status=ready" {
		t.Errorf("url = %s", got)
	}
	if got := (*calls)[0].header.Get("Authorization"); got != "Bearer dm_svc_token" {
		t.Errorf("authorization = %q", got)
	}
}

func TestFindAllPagesUntilEveryRowIsRead(t *testing.T) {
	c, calls := stub(t, func(r *http.Request, _ int) (int, string) {
		skip, _ := strconv.Atoi(r.URL.Query().Get("$skip"))

		return 200, pageBody(skip, 250)
	})
	rows, err := findAll[idRow](ctx, c, "image-usages", Query{}.Set("reportId", "report-1"), 0, false)
	if err != nil || len(rows) != 250 || len(*calls) != 3 {
		t.Fatalf("rows %d calls %d err %v", len(rows), len(*calls), err)
	}
	for i, want := range []string{"0", "100", "200"} {
		if got := (*calls)[i].url.Query().Get("$skip"); got != want {
			t.Errorf("call %d skip = %s", i, got)
		}
	}
}

func TestFindAllStopsOnEmptyPage(t *testing.T) {
	c, calls := stub(t, func(*http.Request, int) (int, string) { return 200, `{"total":500,"data":[]}` })
	rows, err := findAll[idRow](ctx, c, "image-usages", Query{}, 0, false)
	if err != nil || len(rows) != 0 || len(*calls) != 1 {
		t.Errorf("rows %v calls %d err %v", rows, len(*calls), err)
	}
}

func TestFindAllPageBound(t *testing.T) {
	c, calls := stub(t, func(r *http.Request, _ int) (int, string) {
		skip, _ := strconv.Atoi(r.URL.Query().Get("$skip"))

		return 200, pageBody(skip, 1000)
	})
	if _, err := findAll[idRow](ctx, c, "reports", Query{}, 2, false); err == nil || !strings.Contains(err.Error(), "more than 2 pages") {
		t.Errorf("err = %v", err)
	}
	*calls = nil
	rows, err := findAll[idRow](ctx, c, "reports", Query{}, 2, true)
	if err != nil || len(rows) != 200 || len(*calls) != 2 {
		t.Errorf("truncated rows %d calls %d err %v", len(rows), len(*calls), err)
	}
}

func TestFindPageNormalisesBareArray(t *testing.T) {
	c, _ := stub(t, func(*http.Request, int) (int, string) { return 200, `[{"id":"a"}]` })
	p, err := findPage[idRow](ctx, c, "reports", Query{})
	if err != nil || p.Total != 1 || p.Data[0].ID != "a" {
		t.Errorf("page = %+v err %v", p, err)
	}
}

func TestFindPageErrors(t *testing.T) {
	c, _ := stub(t, func(*http.Request, int) (int, string) { return 401, `{"name":"NotAuthenticated"}` })
	_, err := findPage[idRow](ctx, c, "reports", Query{})
	var reqErr *RequestError
	if !errors.As(err, &reqErr) || reqErr.Status != 401 || !strings.Contains(err.Error(), "NotAuthenticated") {
		t.Errorf("err = %v", err)
	}

	c, _ = stub(t, func(*http.Request, int) (int, string) { return 200, `{"unexpected":true}` })
	if _, err := findPage[idRow](ctx, c, "reports", Query{}); err == nil || !strings.Contains(err.Error(), "Unexpected response shape") {
		t.Errorf("err = %v", err)
	}

	// A transport failure is reported as such.
	dead := &Client{BaseURL: "http://127.0.0.1:1", Token: "x"}
	if _, err := findPage[idRow](ctx, dead, "reports", Query{}); !errors.As(err, &reqErr) || !strings.Contains(err.Error(), "failed:") {
		t.Errorf("transport err = %v", err)
	}
}
