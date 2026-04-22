NAME    := $(shell node -p "require('./package.json').name")
VERSION := $(shell node -p "require('./package.json').version")
VSIX    := out/$(NAME)-$(VERSION).vsix

VSCE  := npx --yes @vscode/vsce
TSC   := npx tsc

.PHONY: all package compile clean

all: package

package: compile
	$(VSCE) package --no-dependencies --allow-missing-repository --out $(VSIX)

compile:
	$(TSC) -p ./

clean:
	rm -rf out $(VSIX)
