package crawler

import (
	"context"
	"errors"
)

// RepositoryLicense is the forge's reported repository license, not an image's
// dependency license inventory. URL points to the observed license file.
type RepositoryLicense struct {
	SPDXID string `json:"spdxId,omitempty"`
	Name   string `json:"name,omitempty"`
	URL    string `json:"url,omitempty"`
}

func (c *Crawler) repositoryLicense(ctx context.Context, loc location) (*RepositoryLicense, error) {
	if loc.forge != GitHub {
		return nil, nil
	}
	var response struct {
		HTMLURL string `json:"html_url"`
		License *struct {
			SPDXID string `json:"spdx_id"`
			Name   string `json:"name"`
		} `json:"license"`
	}
	err := c.fetchFor(loc).getJSON(ctx, c.githubAPIFor(loc)+"/repos/"+loc.path+"/license", &response)
	if errors.Is(err, errNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if response.License == nil {
		return nil, nil
	}
	return &RepositoryLicense{SPDXID: response.License.SPDXID, Name: response.License.Name, URL: response.HTMLURL}, nil
}
