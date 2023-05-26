"use server";

import { OpenAIEmbeddings } from "langchain/embeddings/openai";
import { SupabaseHybridSearch } from "langchain/retrievers/supabase";
import { createClient } from "@supabase/supabase-js";
// should be global, not scoped to supabase
import { PromptGenerator, promptTemplates } from "./prompts";
import { getRecursiveAiResponse } from ".";
import { revalidateTag } from "next/cache";
import { getChatCompletionFromText } from "@app/open-ai";

// !! import { revalidatePath } from "next/cache";

// TODO: move to env
// supabase
const _SUPABASE_REQUEST_INTERVAL = 1500; // 1.5s
const _SUPABASE_REQUEST_LIMIT = 10; // limit supabase request i to 10 requests for every user sumbit
const _SUPABASE_CLIENT = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_PRIVATE_KEY || ""
);

const _MIN_RELEVANT_DOCS = 3;

type SupaBaseDoc = {
  count: null | number;
  data: null | {
    content: string;
    created_at: string;
    embedding: string;
  };
  id: null | number;
  // error: null | Error;
  status: number;
  statusText: string;
};

// openai
const _EMBEDDINGS_TIMEOUT = 0; // 0 means no timeout
const _USER_INPUT_LIMIT = 1000; // 1000 tokens, token ~= 1 word
const _OPEN_AI_EMBEDDINGS = new OpenAIEmbeddings({
  timeout: _EMBEDDINGS_TIMEOUT,
});
const _RETRIEVER = new SupabaseHybridSearch(_OPEN_AI_EMBEDDINGS, {
  client: _SUPABASE_CLIENT,
});

const _getMostImportantKeywords = async (text: string): Promise<string[]> => {
  const generatePrompt = PromptGenerator.new(
    promptTemplates.getMostImportantKeywords
  );
  const prompt: string = generatePrompt({
    text,
  });
  const aiResponse = await getChatCompletionFromText(prompt);
  const keywords = aiResponse.split(", ");
  const isValidKeyWords = keywords.length > 0 && keywords.length <= 10;
  if (!isValidKeyWords) {
    throw new Error("Invalid keywords");
  }

  return keywords;
};

export type _ContextualAiResponse = {
  aiResponse: string;
  relevantDocuments: string[];
};
export const _getContextualAiResponse = async (
  input: string
): Promise<_ContextualAiResponse> => {
  revalidateTag("supabase");
  revalidateTag("open-ai");
  const relevantDocuments = await _getRelevantDocs(input);
  const aiResponse: string = await getRecursiveAiResponse(
    input.trim().replaceAll("\n", " "),
    relevantDocuments
  );
  return {
    aiResponse,
    relevantDocuments,
  };
};

export const _storeAsEmbeddings = async (content: string, metadata?: any) => {
  const embedding = await _OPEN_AI_EMBEDDINGS.embedQuery(content);

  const supabaseResponse: "error" | "success" = await _insertDocument(
    content,
    embedding
  );
  if (supabaseResponse === "error")
    throw new Error("Failed to insert document into supabase");
  return supabaseResponse;
};

const _insertDocument = async (
  content: string,
  embedding: number[]
): Promise<"error" | "success"> => {
  const response = await _SUPABASE_CLIENT
    .from("documents")
    .insert([{ content, embedding }])
    .select();

  if (response.error) return "error";
  return "success";
};

export const _getRelevantDocs = async (input: string): Promise<string[]> => {
  const relevantDocs: string[] = [];
  const trimmedInput = input.trim().replaceAll("\n", " /n ");

  // Use supabase hybrid search to get relevant docs
  const inputRelevantDocs = await _RETRIEVER.getRelevantDocuments(trimmedInput);
  console.log(
    `Found ${inputRelevantDocs.length} relevant docs using supabase hybrid search`
  );
  inputRelevantDocs.forEach((d) => {
    relevantDocs.push(d.pageContent);
  });

  // Get relevant docs for each word in input
  if (relevantDocs.length < _MIN_RELEVANT_DOCS) {
    const words = trimmedInput.split(" ");
    const firstThreeWords = words.slice(0, 3);
    firstThreeWords.forEach(async (w) => {
      const wordRelevantDocs = await _RETRIEVER.getRelevantDocuments(w);
      console.log(
        `Found ${wordRelevantDocs.length} relevant docs for word: ${w}`
      );
      wordRelevantDocs.forEach((d) => {
        if (d.pageContent == "") throw new Error("Page content is empty");
        relevantDocs.push(d.pageContent);
      });
    });
  }

  // Use supabase text search to get similar docs
  if (relevantDocs.length < _MIN_RELEVANT_DOCS) {
    const similarDocs = await _SUPABASE_CLIENT
      .from("documents")
      .select()
      .textSearch("content", trimmedInput, {
        type: "websearch",
        config: "english",
      });
    console.log(
      `Found ${
        similarDocs.data?.length || 0
      } similar docs using supabase text search`
    );
    if (similarDocs.error) throw similarDocs.error;
    if (!similarDocs.data) throw new Error("No data returned from supabase");
    similarDocs.data.forEach((d) => {
      const { content, id, metadata, embedding } = d;
      if (content == "") throw new Error("Content is empty");
      relevantDocs.push(content);
    });
  }

  // Remove duplicates
  const relevantDocsSet = new Set(relevantDocs);

  return [...relevantDocsSet];
};

export const _getAllSupabaseDocs = async (table: string): Promise<string[]> => {
  const allDocs: string[] = [];
  const { data, error } = await _SUPABASE_CLIENT.from(table).select("*");
  if (error) throw error;
  if (!data) throw new Error("No data returned from supabase");
  data.forEach((d) => {
    const { content, id, metadata, embedding } = d;
    if (content == "") throw new Error("Content is empty");
    allDocs.push(content);
  });
  return allDocs;
};
