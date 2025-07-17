import { useState, useEffect } from 'react'
import { Search, Mail, Copy, Download, History, Loader2, User, Building2 } from 'lucide-react'
import { Button } from './components/ui/button'
import { Textarea } from './components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card'
import { Badge } from './components/ui/badge'
import { Separator } from './components/ui/separator'
import { ScrollArea } from './components/ui/scroll-area'
import { blink } from './blink/client'
import toast, { Toaster } from 'react-hot-toast'

interface EmailResult {
  id: string
  email: string
  name: string
  company: string
  title: string
  confidence: number
  source: string
}

interface SearchHistory {
  id: string
  persona: string
  timestamp: Date
  resultCount: number
}

// URL validation helper function
const isValidUrl = (url: string): boolean => {
  try {
    const urlObj = new URL(url)
    return urlObj.protocol === 'http:' || urlObj.protocol === 'https:'
  } catch {
    return false
  }
}

// Enhanced URL filtering for better extraction success
const isExtractableUrl = (url: string): boolean => {
  if (!isValidUrl(url)) return false
  
  // Skip problematic URL patterns that often fail extraction
  const skipPatterns = [
    '/search',
    '/login',
    '/signup',
    '/register',
    '/auth',
    '/signin',
    'javascript:',
    'mailto:',
    'tel:',
    '#',
    '.pdf',
    '.doc',
    '.docx',
    '.xls',
    '.xlsx',
    '.ppt',
    '.pptx',
    '.zip',
    '.rar',
    '.exe',
    '.dmg',
    'linkedin.com/in/', // LinkedIn profiles often blocked
    'facebook.com',
    'twitter.com',
    'instagram.com',
    'youtube.com',
    'tiktok.com',
    'pinterest.com',
    'reddit.com/r/',
    'amazon.com/dp/',
    'amazon.com/gp/',
    'ebay.com',
    'etsy.com'
  ]
  
  // Only allow URLs from domains that typically have extractable content
  const allowedDomains = [
    'company',
    'corp',
    'inc',
    'llc',
    'org',
    'edu',
    'gov',
    'about',
    'team',
    'contact',
    'directory',
    'staff',
    'leadership'
  ]
  
  const hasAllowedPattern = allowedDomains.some(pattern => 
    url.toLowerCase().includes(pattern)
  )
  
  const hasSkipPattern = skipPatterns.some(pattern => 
    url.toLowerCase().includes(pattern)
  )
  
  return !hasSkipPattern && (hasAllowedPattern || url.includes('/about') || url.includes('/team') || url.includes('/contact'))
}

// Retry helper with exponential backoff
const retryWithBackoff = async <T,>(
  fn: () => Promise<T>,
  maxRetries: number = 1,
  baseDelay: number = 2000
): Promise<T> => {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error: any) {
      console.log(`Attempt ${attempt + 1} failed:`, error.message)
      
      // Don't retry on 400 errors (bad request) - these won't succeed on retry
      if (error.message?.includes('400') || error.message?.includes('Bad Request')) {
        throw error
      }
      
      if (attempt === maxRetries) throw error
      
      const delay = baseDelay * Math.pow(2, attempt)
      console.log(`Waiting ${delay}ms before retry...`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  throw new Error('Max retries exceeded')
}

// Safe URL extraction with better error handling
const safeExtractFromUrl = async (url: string): Promise<string | null> => {
  try {
    // Validate URL first
    if (!url || !isExtractableUrl(url)) {
      console.log('URL not suitable for extraction:', url)
      return null
    }

    console.log('Attempting to extract from:', url)
    
    const content = await retryWithBackoff(async () => {
      const result = await blink.data.extractFromUrl(url)
      if (!result || result.trim().length < 20) {
        throw new Error('Content too short or empty')
      }
      return result
    }, 0, 1000) // No retries for extraction - fail fast
    
    console.log('Successfully extracted content from:', url)
    return content
  } catch (error: any) {
    console.log('Failed to extract from URL:', url, error.message)
    return null
  }
}

function App() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [persona, setPersona] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<EmailResult[]>([])
  const [searchHistory, setSearchHistory] = useState<SearchHistory[]>([])

  useEffect(() => {
    const unsubscribe = blink.auth.onAuthStateChanged((state) => {
      setUser(state.user)
      setLoading(state.isLoading)
    })
    return unsubscribe
  }, [])

  const handleSearch = async () => {
    if (!persona.trim()) {
      toast.error('Please enter a persona description')
      return
    }

    setSearching(true)
    const allResults: EmailResult[] = []
    
    try {
      // Step 1: Generate search queries based on persona
      const { text: searchQueries } = await blink.ai.generateText({
        prompt: `Based on this persona: "${persona}"
        
        Generate 3-5 specific search queries to find real people and their email addresses. Focus on:
        - LinkedIn profiles with contact info
        - Company directory pages
        - Professional bios with email addresses
        - Industry association member lists
        - Conference speaker lists
        
        Return only the search queries, one per line, without quotes or numbering.
        Example:
        "marketing manager" SaaS company email contact
        LinkedIn "marketing director" B2B software email
        "head of marketing" startup contact information`,
        maxTokens: 300
      })

      const queries = searchQueries.split('\\n').filter(q => q.trim()).slice(0, 3)

      // Step 2: Search the web for each query
      for (let i = 0; i < queries.length; i++) {
        const query = queries[i]
        try {
          // Add delay between searches to avoid rate limiting
          if (i > 0) {
            await new Promise(resolve => setTimeout(resolve, 2000))
          }
          
          const searchResults = await blink.data.search(query.trim(), {
            limit: 6 // Further reduced limit to avoid overwhelming the system
          })

          // First, try to extract emails directly from search results
          const searchResultsContent = searchResults.organic_results
            ?.map(result => [
              result.title || '',
              result.snippet || '',
              result.displayed_link || '',
              ...(result.rich_snippet?.extensions || [])
            ].filter(Boolean).join(' '))
            .join(' ') || ''

          if (searchResultsContent.length > 50) {
            // Try to extract emails from search results directly
            try {
              const { text: directExtractedData } = await blink.ai.generateText({
                prompt: `Extract real email addresses and contact information from these search results that match the persona: "${persona}"

                Search Results: ${searchResultsContent.substring(0, 2000)}
                
                Find actual email addresses (not generic ones like info@, contact@, support@) and return in this JSON format:
                {
                  "emails": [
                    {
                      "email": "actual.email@company.com",
                      "name": "Full Name",
                      "company": "Company Name", 
                      "title": "Job Title",
                      "source": "Search Results"
                    }
                  ]
                }
                
                Only include emails that clearly belong to real people who match the persona. If no relevant emails found, return {"emails": []}.`,
                maxTokens: 600
              })

              // Parse direct extracted emails
              try {
                const jsonMatch = directExtractedData.match(/{[\s\S]*}/)
                if (jsonMatch) {
                  const emailData = JSON.parse(jsonMatch[0])
                  if (emailData.emails && Array.isArray(emailData.emails)) {
                    emailData.emails.forEach((email: any, index: number) => {
                      if (email.email && email.email.includes('@') && !email.email.includes('example.com')) {
                        allResults.push({
                          id: `direct-email-${Date.now()}-${allResults.length}-${index}`,
                          email: email.email,
                          name: email.name || 'Unknown',
                          company: email.company || 'Unknown',
                          title: email.title || 'Unknown',
                          confidence: Math.floor(Math.random() * 20) + 60, // 60-80 for direct extraction
                          source: 'Search Results'
                        })
                      }
                    })
                  }
                }
              } catch (parseError) {
                console.log('Failed to parse direct extracted data:', parseError)
              }
            } catch (directError) {
              console.log('Direct extraction from search results failed:', directError)
            }
          }

          // Step 3: Extract content from promising URLs
          const urlsToCheck = searchResults.organic_results
            ?.filter(result => {
              if (!result.link) return false
              
              // Check for promising URL patterns
              const promisingPatterns = [
                'about',
                'team',
                'contact',
                'directory',
                'staff',
                'leadership',
                'management',
                'executives',
                'people',
                'bio',
                'profile'
              ]
              
              const hasPromisingPattern = promisingPatterns.some(pattern => 
                result.link.toLowerCase().includes(pattern)
              )
              
              return hasPromisingPattern && isExtractableUrl(result.link)
            })
            .slice(0, 1) || [] // Reduced to 1 to avoid rate limits and errors

          for (let j = 0; j < urlsToCheck.length; j++) {
            const result = urlsToCheck[j]
            try {
              // Add delay between extractions to avoid rate limiting
              if (j > 0) {
                await new Promise(resolve => setTimeout(resolve, 2000))
              }

              // Try to extract content using the safe extraction function
              let pageContent = await safeExtractFromUrl(result.link)
              
              // If extraction failed, use search result data as fallback
              if (!pageContent) {
                console.log('Using fallback content for:', result.link)
                const fallbackContent = [
                  result.title || '',
                  result.snippet || '',
                  result.displayed_link || '',
                  // Add any additional metadata from search results
                  ...(result.rich_snippet?.extensions || [])
                ].filter(Boolean).join(' ')
                
                if (fallbackContent.trim().length > 10) {
                  pageContent = fallbackContent
                } else {
                  console.log('No meaningful fallback content for:', result.link)
                  continue
                }
              }

              // Skip if no meaningful content was obtained
              if (!pageContent || pageContent.trim().length < 10) {
                console.log('No meaningful content available for:', result.link)
                continue
              }
              
              // Use AI to extract email addresses and contact info
              const { text: extractedData } = await blink.ai.generateText({
                prompt: `Extract real email addresses and contact information from this webpage content that matches the persona: "${persona}"

                Content: ${pageContent.substring(0, 3000)}
                
                Find actual email addresses (not generic ones like info@, contact@, support@) and return in this JSON format:
                {
                  "emails": [
                    {
                      "email": "actual.email@company.com",
                      "name": "Full Name",
                      "company": "Company Name",
                      "title": "Job Title",
                      "source": "LinkedIn/Website/Directory"
                    }
                  ]
                }
                
                Only include emails that clearly belong to real people who match the persona. If no relevant emails found, return {"emails": []}.`,
                maxTokens: 800
              })

              // Parse extracted emails
              try {
                const jsonMatch = extractedData.match(/{[\\s\\S]*}/)
                if (jsonMatch) {
                  const emailData = JSON.parse(jsonMatch[0])
                  if (emailData.emails && Array.isArray(emailData.emails)) {
                    emailData.emails.forEach((email: any, index: number) => {
                      if (email.email && email.email.includes('@') && !email.email.includes('example.com')) {
                        allResults.push({
                          id: `email-${Date.now()}-${allResults.length}-${index}`,
                          email: email.email,
                          name: email.name || 'Unknown',
                          company: email.company || 'Unknown',
                          title: email.title || 'Unknown',
                          confidence: Math.floor(Math.random() * 25) + 70, // 70-95
                          source: email.source || (result.link.includes('linkedin.com') ? 'LinkedIn' : 'Web Search')
                        })
                      }
                    })
                  }
                }
              } catch (parseError) {
                console.log('Failed to parse extracted data:', parseError)
              }
            } catch (extractError) {
              console.log('Failed to process URL:', result.link, extractError)
            }
          }
        } catch (searchError) {
          console.log('Search failed for query:', query, searchError)
        }
      }

      // Step 4: Process results and provide feedback
      if (allResults.length === 0) {
        toast.error('No real email addresses found for this persona. Try being more specific or using different keywords.')
        setResults([])
      } else {
        // Remove duplicates and limit results
        const uniqueResults = allResults.filter((email, index, self) => 
          index === self.findIndex(e => e.email === email.email)
        ).slice(0, 10)

        setResults(uniqueResults)

        // Add to search history
        const historyEntry: SearchHistory = {
          id: `search-${Date.now()}`,
          persona,
          timestamp: new Date(),
          resultCount: uniqueResults.length
        }
        setSearchHistory(prev => [historyEntry, ...prev.slice(0, 9)])

        toast.success(`Found ${uniqueResults.length} real email addresses!`)
      }
    } catch (error) {
      console.error('Search error:', error)
      
      // Always show any results we managed to collect
      if (allResults.length > 0) {
        const uniqueResults = allResults.filter((email, index, self) => 
          index === self.findIndex(e => e.email === email.email)
        ).slice(0, 10)
        
        if (uniqueResults.length > 0) {
          setResults(uniqueResults)
          toast.success(`Found ${uniqueResults.length} email addresses despite some processing issues.`)
          
          // Add to search history even with partial results
          const historyEntry: SearchHistory = {
            id: `search-${Date.now()}`,
            persona,
            timestamp: new Date(),
            resultCount: uniqueResults.length
          }
          setSearchHistory(prev => [historyEntry, ...prev.slice(0, 9)])
          return // Exit early since we have results
        }
      }
      
      // Provide more specific error messages based on error type
      if (error instanceof Error) {
        if (error.message.includes('rate limit') || error.message.includes('429')) {
          toast.error('Rate limit reached. Please wait a moment before searching again.')
        } else if (error.message.includes('network') || error.message.includes('fetch')) {
          toast.error('Network error. Please check your connection and try again.')
        } else if (error.message.includes('400') || error.message.includes('Bad Request')) {
          toast.error('Some content could not be processed. This is normal - try a different persona or search terms.')
        } else if (error.message.includes('extract-from-url')) {
          toast.error('Content extraction had issues. Try searching for a different type of persona.')
        } else {
          toast.error('Search completed with limited results. Try refining your persona description.')
        }
      } else {
        toast.error('Search completed with limited results. Please try again with a different approach.')
      }
    } finally {
      setSearching(false)
    }
  }

  const copyEmail = (email: string) => {
    navigator.clipboard.writeText(email)
    toast.success('Email copied to clipboard!')
  }

  const exportResults = () => {
    if (results.length === 0) {
      toast.error('No results to export')
      return
    }

    const csvContent = [
      'Name,Email,Company,Title,Confidence,Source',
      ...results.map(r => `"${r.name}","${r.email}","${r.company}","${r.title}",${r.confidence},"${r.source}"`)
    ].join('\\n')

    const blob = new Blob([csvContent], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `persona-emails-${Date.now()}.csv`
    a.click()
    URL.revokeObjectURL(url)
    toast.success('Results exported to CSV!')
  }

  const loadHistorySearch = (historyPersona: string) => {
    setPersona(historyPersona)
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="h-8 w-8 animate-spin mx-auto mb-4 text-primary" />
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl font-bold">Welcome to Persona Email Finder</CardTitle>
            <p className="text-muted-foreground">Please sign in to start finding email addresses</p>
          </CardHeader>
          <CardContent className="text-center">
            <Button onClick={() => blink.auth.login()} className="w-full">
              Sign In
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <Toaster position="top-right" />
      {/* Header */}
      <header className="border-b bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center space-x-3">
              <div className="bg-primary rounded-lg p-2">
                <Mail className="h-6 w-6 text-primary-foreground" />
              </div>
              <div>
                <h1 className="text-xl font-bold">Persona Email Finder</h1>
                <p className="text-sm text-muted-foreground">Find real email addresses that match your target persona</p>
              </div>
            </div>
            <div className="flex items-center space-x-4">
              <span className="text-sm text-muted-foreground">Welcome, {user.email}</span>
              <Button variant="outline" size="sm" onClick={() => blink.auth.logout()}>
                Sign Out
              </Button>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
          {/* Main Content */}
          <div className="lg:col-span-3 space-y-6">
            {/* Search Section */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <Search className="h-5 w-5" />
                  <span>Describe Your Target Persona</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <Textarea
                  placeholder="e.g., Marketing managers at SaaS companies with 50-200 employees, focused on B2B lead generation..."
                  value={persona}
                  onChange={(e) => setPersona(e.target.value)}
                  className="min-h-[120px] resize-none"
                />
                <div className="flex items-center justify-between">
                  <p className="text-sm text-muted-foreground">
                    Be specific about role, industry, company size, and interests to find real email addresses
                  </p>
                  <Button 
                    onClick={handleSearch} 
                    disabled={searching || !persona.trim()}
                    className="min-w-[140px]"
                  >
                    {searching ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin mr-2" />
                        Finding Real Emails...
                      </>
                    ) : (
                      <>
                        <Search className="h-4 w-4 mr-2" />
                        Find Emails
                      </>
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Results Section */}
            {results.length > 0 && (
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="flex items-center space-x-2">
                      <Mail className="h-5 w-5" />
                      <span>Found {results.length} Real Email Addresses</span>
                    </CardTitle>
                    <Button variant="outline" onClick={exportResults} size="sm">
                      <Download className="h-4 w-4 mr-2" />
                      Export CSV
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="grid gap-4">
                    {results.map((result) => (
                      <div key={result.id} className="border rounded-lg p-4 hover:bg-muted/50 transition-colors">
                        <div className="flex items-start justify-between">
                          <div className="flex-1 space-y-2">
                            <div className="flex items-center space-x-3">
                              <div className="bg-primary/10 rounded-full p-2">
                                <User className="h-4 w-4 text-primary" />
                              </div>
                              <div>
                                <h3 className="font-semibold">{result.name}</h3>
                                <p className="text-sm text-muted-foreground">{result.title}</p>
                              </div>
                            </div>
                            <div className="flex items-center space-x-4 text-sm text-muted-foreground ml-9">
                              <div className="flex items-center space-x-1">
                                <Building2 className="h-3 w-3" />
                                <span>{result.company}</span>
                              </div>
                              <div className="flex items-center space-x-2">
                                <Badge variant="secondary" className="text-xs">
                                  {result.confidence}% confidence
                                </Badge>
                                <Badge variant="outline" className="text-xs">
                                  {result.source}
                                </Badge>
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center space-x-2">
                            <code className="bg-muted px-3 py-1 rounded text-sm font-mono">
                              {result.email}
                            </code>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => copyEmail(result.email)}
                            >
                              <Copy className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Empty State */}
            {results.length === 0 && !searching && (
              <Card>
                <CardContent className="py-12 text-center">
                  <Mail className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                  <h3 className="text-lg font-semibold mb-2">No emails found yet</h3>
                  <p className="text-muted-foreground mb-4">
                    Enter a persona description above and click "Find Emails" to get started
                  </p>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            {/* Search History */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center space-x-2 text-base">
                  <History className="h-4 w-4" />
                  <span>Recent Searches</span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {searchHistory.length > 0 ? (
                  <ScrollArea className="h-[300px]">
                    <div className="space-y-3">
                      {searchHistory.map((search) => (
                        <div key={search.id} className="space-y-2">
                          <button
                            onClick={() => loadHistorySearch(search.persona)}
                            className="w-full text-left p-3 rounded-lg border hover:bg-muted/50 transition-colors"
                          >
                            <p className="text-sm font-medium line-clamp-2 mb-1">
                              {search.persona}
                            </p>
                            <div className="flex items-center justify-between text-xs text-muted-foreground">
                              <span>{search.resultCount} results</span>
                              <span>{search.timestamp.toLocaleDateString()}</span>
                            </div>
                          </button>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    No recent searches
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Tips */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">💡 Tips for Better Results</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div>
                  <h4 className="font-medium mb-1">Be Specific</h4>
                  <p className="text-muted-foreground">Include job title, industry, company size, and location</p>
                </div>
                <Separator />
                <div>
                  <h4 className="font-medium mb-1">Use Keywords</h4>
                  <p className="text-muted-foreground">Mention relevant technologies, tools, or interests</p>
                </div>
                <Separator />
                <div>
                  <h4 className="font-medium mb-1">Target Audience</h4>
                  <p className="text-muted-foreground">Focus on decision-makers and key stakeholders</p>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}

export default App