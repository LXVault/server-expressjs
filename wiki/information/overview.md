# Overview

`mcp-rag-server` is the Express.js backend for the MCP Server with Knowledge Base (RAG)
feature. It stores projects and their knowledge, embeds text into vectors, answers semantic
search, and records who did what.

Two clients talk to it, both over the same `/api` surface:

* **The web app**, `LXVault/client-reactjs`, used by people. It authenticates with a JWT.
* **The MCP server**, `LXVault/mcp`, used by AI assistants on a person's behalf. It
  authenticates with a per project token so every action it takes is attributable to the
  user who issued that token.

## Concepts

**Project.** A knowledge base with an owner, members, files and chunks. It is stored in the
`documents` table, and the API calls it a document in some places and a project in others.
They are the same thing; the table name predates the product naming.

**Member and role.** A project has one owner plus any number of members. Roles are
`admin`, `editor` and `viewer`. The owner and admins may change the project, add members,
upload files and change the embedding model. Everyone with access may read and search.

**File.** A source document uploaded into a project: `.md`, `.txt` or `.pdf`. The file row
in `document_files` is the record of what the knowledge base was built from. Deleting it
removes the chunks it produced.

**Chunk.** A slice of extracted text, about 1000 characters with a 100 character overlap so
meaning is not lost at the boundary. Chunks are what search returns.

**Embedding.** A vector produced from a chunk by an embedding model, stored in pgvector.
Search embeds the query with the same model and ranks chunks by cosine distance.

**Embedding model.** Chosen per project, as an OpenRouter model id such as
`openai/text-embedding-3-small`. Vectors from two different models are not comparable, so
search only considers chunks embedded with the project's current model.

**Project token.** A per project, per user execution token. The MCP server presents it, and
the backend resolves the acting user and the target project from the token alone. A user
holds at most one active token per project.

**OpenRouter key.** Each user supplies their own, and the server stores it encrypted with
AES-256-GCM. There is no shared or server owned key: every embedding call spends the
acting user's credits, and a user without a key gets a clear `412` rather than someone
else's quota.

## What it does not do

It does not generate text, run an assistant, or call a chat model. It embeds, stores,
searches, and audits. Everything conversational happens in the MCP client.

Request flow, layer boundaries and the schema:
[architecture.md](architecture.md).
