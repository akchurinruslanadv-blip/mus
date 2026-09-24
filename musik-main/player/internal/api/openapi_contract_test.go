package api

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestEmbeddedOpenAPIMatchesRegisteredRoutes(t *testing.T) {
	var document struct {
		Paths map[string]map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal(openAPIJSON, &document); err != nil {
		t.Fatalf("parse embedded OpenAPI: %v", err)
	}

	registered := make(map[string]struct{}, len(apiRoutes))
	for _, route := range apiRoutes {
		registered[route.method+" "+route.path] = struct{}{}
	}
	documented := make(map[string]struct{}, len(apiRoutes))
	for path, pathItem := range document.Paths {
		for method := range pathItem {
			method = strings.ToUpper(method)
			switch method {
			case "GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD":
				documented[method+" "+path] = struct{}{}
			}
		}
	}

	for route := range registered {
		if _, ok := documented[route]; !ok {
			t.Errorf("registered route missing from OpenAPI: %s", route)
		}
	}
	for route := range documented {
		if _, ok := registered[route]; !ok {
			t.Errorf("OpenAPI route is not registered: %s", route)
		}
	}
}
