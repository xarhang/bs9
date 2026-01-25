#!/usr/bin/env bun

/**
 * BS9 - Bun Sentinel 9
 * High-performance, non-root process manager for Bun
 * 
 * Copyright (c) 2026 BS9 (Bun Sentinel 9)
 * Licensed under the MIT License
 * https://github.com/xarhang/bs9
 */

import { serve } from "bun";

// Database simulation (in real app, use actual database)
class Database {
  constructor() {
    this.users = new Map();
    this.posts = new Map();
    this.comments = new Map();
    this.initializeData();
  }
  
  initializeData() {
    // Initialize with sample data
    this.users.set(1, {
      id: 1,
      name: 'John Doe',
      email: 'john@example.com',
      bio: 'Software developer',
      createdAt: new Date().toISOString()
    });
    
    this.users.set(2, {
      id: 2,
      name: 'Jane Smith',
      email: 'jane@example.com',
      bio: 'Product manager',
      createdAt: new Date().toISOString()
    });
    
    this.posts.set(1, {
      id: 1,
      title: 'Welcome to BS9',
      content: 'BS9 is an amazing process manager for Bun applications!',
      authorId: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    
    this.posts.set(2, {
      id: 2,
      title: 'Getting Started with BS9',
      content: 'This guide will help you get started with BS9 in no time.',
      authorId: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    
    this.comments.set(1, {
      id: 1,
      postId: 1,
      userId: 2,
      content: 'Great post! Thanks for sharing.',
      createdAt: new Date().toISOString()
    });
  }
  
  async getUsers() {
    return Array.from(this.users.values());
  }
  
  async getUser(id) {
    return this.users.get(id);
  }
  
  async createUser(userData) {
    const id = Math.max(...Array.from(this.users.keys())) + 1;
    const user = {
      id,
      ...userData,
      createdAt: new Date().toISOString()
    };
    this.users.set(id, user);
    return user;
  }
  
  async getPosts() {
    return Array.from(this.posts.values());
  }
  
  async getPost(id) {
    return this.posts.get(id);
  }
  
  async createPost(postData) {
    const id = Math.max(...Array.from(this.posts.keys())) + 1;
    const post = {
      id,
      ...postData,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.posts.set(id, post);
    return post;
  }
  
  async getComments(postId) {
    return Array.from(this.comments.values()).filter(c => c.postId === postId);
  }
  
  async createComment(commentData) {
    const id = Math.max(...Array.from(this.comments.keys())) + 1;
    const comment = {
      id,
      ...commentData,
      createdAt: new Date().toISOString()
    };
    this.comments.set(id, comment);
    return comment;
  }
}

const db = new Database();
const PORT = process.env.PORT || 3004;

const server = serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const method = req.method;
    
    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    
    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: corsHeaders });
    }
    
    try {
      // API Routes
      if (url.pathname === '/api/health' && method === 'GET') {
        return new Response(JSON.stringify({
          status: 'healthy',
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          database: {
            users: db.users.size,
            posts: db.posts.size,
            comments: db.comments.size
          }
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      
      // Users endpoints
      if (url.pathname === '/api/users' && method === 'GET') {
        const users = await db.getUsers();
        return new Response(JSON.stringify({
          users,
          total: users.length,
          timestamp: new Date().toISOString()
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      
      if (url.pathname.startsWith('/api/users/') && method === 'GET') {
        const id = parseInt(url.pathname.split('/')[3]);
        const user = await db.getUser(id);
        
        if (!user) {
          return new Response(JSON.stringify({
            error: 'User not found',
            timestamp: new Date().toISOString()
          }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        
        return new Response(JSON.stringify({
          user,
          timestamp: new Date().toISOString()
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      
      if (url.pathname === '/api/users' && method === 'POST') {
        const body = await req.json();
        const { name, email, bio } = body;
        
        if (!name || !email) {
          return new Response(JSON.stringify({
            error: 'Name and email are required',
            timestamp: new Date().toISOString()
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        
        const user = await db.createUser({ name, email, bio });
        return new Response(JSON.stringify({
          message: 'User created successfully',
          user,
          timestamp: new Date().toISOString()
        }), {
          status: 201,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      
      // Posts endpoints
      if (url.pathname === '/api/posts' && method === 'GET') {
        const posts = await db.getPosts();
        const postsWithAuthors = posts.map(post => ({
          ...post,
          author: db.users.get(post.authorId)
        }));
        
        return new Response(JSON.stringify({
          posts: postsWithAuthors,
          total: posts.length,
          timestamp: new Date().toISOString()
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      
      if (url.pathname.startsWith('/api/posts/') && method === 'GET') {
        const id = parseInt(url.pathname.split('/')[3]);
        const post = await db.getPost(id);
        
        if (!post) {
          return new Response(JSON.stringify({
            error: 'Post not found',
            timestamp: new Date().toISOString()
          }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        
        const comments = await db.getComments(id);
        const postWithDetails = {
          ...post,
          author: db.users.get(post.authorId),
          comments: comments.map(comment => ({
            ...comment,
            author: db.users.get(comment.userId)
          }))
        };
        
        return new Response(JSON.stringify({
          post: postWithDetails,
          timestamp: new Date().toISOString()
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      
      if (url.pathname === '/api/posts' && method === 'POST') {
        const body = await req.json();
        const { title, content, authorId } = body;
        
        if (!title || !content || !authorId) {
          return new Response(JSON.stringify({
            error: 'Title, content, and authorId are required',
            timestamp: new Date().toISOString()
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        
        const post = await db.createPost({ title, content, authorId });
        return new Response(JSON.stringify({
          message: 'Post created successfully',
          post,
          timestamp: new Date().toISOString()
        }), {
          status: 201,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      
      // Comments endpoints
      if (url.pathname.startsWith('/api/posts/') && url.pathname.endsWith('/comments') && method === 'GET') {
        const postId = parseInt(url.pathname.split('/')[3]);
        const comments = await db.getComments(postId);
        const commentsWithAuthors = comments.map(comment => ({
          ...comment,
          author: db.users.get(comment.userId)
        }));
        
        return new Response(JSON.stringify({
          comments: commentsWithAuthors,
          total: comments.length,
          timestamp: new Date().toISOString()
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      
      if (url.pathname.startsWith('/api/posts/') && url.pathname.endsWith('/comments') && method === 'POST') {
        const postId = parseInt(url.pathname.split('/')[3]);
        const body = await req.json();
        const { content, userId } = body;
        
        if (!content || !userId) {
          return new Response(JSON.stringify({
            error: 'Content and userId are required',
            timestamp: new Date().toISOString()
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        
        const comment = await db.createComment({ postId, content, userId });
        return new Response(JSON.stringify({
          message: 'Comment created successfully',
          comment,
          timestamp: new Date().toISOString()
        }), {
          status: 201,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      
      // Root endpoint
      if (url.pathname === '/') {
        return new Response(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>BS9 Database Example</title>
            <style>
              body { font-family: Arial, sans-serif; margin: 20px; }
              .container { max-width: 800px; margin: 0 auto; }
              .endpoint { background: #f5f5f5; padding: 10px; margin: 10px 0; border-radius: 5px; }
              .method { color: #007bff; font-weight: bold; }
              .path { color: #28a745; font-family: monospace; }
            </style>
          </head>
          <body>
            <div class="container">
              <h1>BS9 Database Example API</h1>
              <p>A RESTful API example with database operations, managed by BS9.</p>
              
              <h2>Available Endpoints:</h2>
              
              <div class="endpoint">
                <span class="method">GET</span> <span class="path">/api/health</span> - Health check
              </div>
              
              <div class="endpoint">
                <span class="method">GET</span> <span class="path">/api/users</span> - Get all users
              </div>
              
              <div class="endpoint">
                <span class="method">GET</span> <span class="path">/api/users/:id</span> - Get specific user
              </div>
              
              <div class="endpoint">
                <span class="method">POST</span> <span class="path">/api/users</span> - Create user
              </div>
              
              <div class="endpoint">
                <span class="method">GET</span> <span class="path">/api/posts</span> - Get all posts
              </div>
              
              <div class="endpoint">
                <span class="method">GET</span> <span class="path">/api/posts/:id</span> - Get specific post with comments
              </div>
              
              <div class="endpoint">
                <span class="method">POST</span> <span class="path">/api/posts</span> - Create post
              </div>
              
              <div class="endpoint">
                <span class="method">GET</span> <span class="path">/api/posts/:id/comments</span> - Get post comments
              </div>
              
              <div class="endpoint">
                <span class="method">POST</span> <span class="path">/api/posts/:id/comments</span> - Create comment
              </div>
              
              <h2>Example Usage:</h2>
              <pre>
// Get all users
fetch('/api/users')
  .then(res => res.json())
  .then(data => console.log(data));

// Create a new user
fetch('/api/users', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'Alice Johnson',
    email: 'alice@example.com',
    bio: 'Frontend developer'
  })
})
  .then(res => res.json())
  .then(data => console.log(data));
              </pre>
            </div>
          </body>
          </html>
        `, {
          headers: { 'Content-Type': 'text/html', ...corsHeaders }
        });
      }
      
      // 404 for unknown routes
      return new Response(JSON.stringify({
        error: 'Not Found',
        message: `Route ${method} ${url.pathname} not found`,
        timestamp: new Date().toISOString()
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
      
    } catch (error) {
      console.error('Error handling request:', error);
      return new Response(JSON.stringify({
        error: 'Internal Server Error',
        message: error.message,
        timestamp: new Date().toISOString()
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  },
});

console.log(`Database API server started on port ${PORT}`);
console.log(`Process ID: ${process.pid}`);
console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});
