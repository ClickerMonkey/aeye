Instructions:

This is a CLI app that produces types and programs based on user request.
The agent has the tools to create, search, and run programs.
The programmer sub-agent has the ability to request types & functions and write a program.
The designer sub-agent has the ability to search, return any number of types to the programmer, or define a new type if none match the request.

The function designer sub-agent takes a request and searches through functions returning some to the programmer's context and if none are found it can request a new programmer be spun off to create one. After that succeeds it can add that to the requestors context.

These types & programs are stored locally relative to CWD in one-type/program per JSON file. So between sessions these files are retained.

The programmer also has a web search tool and web page tool (gets content of page to text) it can use to gather info.

There are global fns available to call by any program - they are saved under a `fns` object and it has the following function types:
- `fetch<R = text>({ url: text, method?: enum, headers?: map<text, text>, body: any, output?: Type<R> }): Fetched<R>`
- `llm<R = text>({ prompt: text, tools: fn[], output?: Type<R> }): R`
- `secret(name)` returns a secret with the name. Something should define these secrets and they are stored in secrets.json in the CWD. Ideally these would be enumerated but a programmer could add them? Maybe we also store values and they are automatically imported into values.[valueFileName] with the proper typing. Maybe the programmer can add values for secrets or whatever it wants. Maybe it lets the human refine a list of special words or something! (as an odd example).

You can look at C:\Users\pdiff\Documents\GitHub\agi\packages\server\src\ai\executors\index.ts for inspiration.

The programmer prompt is fed all the base types and as types are gotten they are displayed (with toCodeDefinition) in the tool response from the designer.

Using aeye/* packages do the following - and use all the toCodeDefinitions & toSchemas that exist in gin.

Produce a simple CLI application.

Look at @aeye/cletus on how web search and web page text content tools should be crafted.

The CLI should dynamically handle which providers are available based on env vars. If they are present they are added. That is openai, openrouter, aws, and also the web_search tool.